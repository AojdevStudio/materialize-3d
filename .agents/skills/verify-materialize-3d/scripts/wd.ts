#!/usr/bin/env bun
// WebDriver client for the Materialize 3D verification run started by m3d.sh.
// Talks raw W3C WebDriver to tauri-driver, which launches the real Tauri binary
// through WebKitWebDriver. Every command is appended to <run>/evidence/actions.log
// so a proof records the action next to the resulting state.
//
// Selectors are the ones commands.ts defines for both drivers.
//
//   bun wd.ts session                  start the app (one session per run)
//   bun wd.ts wait <sel> [ms]          wait until <sel> is displayed (default 15000)
//   bun wd.ts gone <sel> [ms]          wait until <sel> is absent or hidden
//   bun wd.ts click <sel>
//   bun wd.ts pointer-click <sel>      click the first match with the run's X11 pointer
//   bun wd.ts hover <sel>              move the pointer over <sel> (reveals hover-only controls)
//   bun wd.ts type <sel> <text> [--clear]
//   bun wd.ts type-secret <sel> <ENV> [--clear]  type the value of $ENV; the log records only its length
//   bun wd.ts keys <text>              send keys to the focused element ( = Enter)
//   bun wd.ts text <sel>               print visible text
//   bun wd.ts attr <sel> <name>        print a DOM property of the first match (visible or not)
//   bun wd.ts count <sel>              print the number of matches
//   bun wd.ts shot <name>              save evidence/<NN>-<name>.png of the webview, then run
//                                      the contrast sweep and report new failures on stderr (exit 0);
//                                      a sweep that cannot run exits 1
//   bun wd.ts contrast [sel]           text contrast of each displayed control, measured against its
//                                      rendered pixels; exit 1 on a failure below 3.0 that is new, or
//                                      lower than its ratio in contrast-baseline.txt
//                                      (default: text-bearing controls; checkboxes and radios carry no text)
//   bun wd.ts eval <js>                run a script (`return ...`), print JSON; inspection only
//   bun wd.ts eval-secret <js>         like eval, but prints a string bare; logs neither script nor value
//   bun wd.ts note <message>           append a free-form line to actions.log
//   bun wd.ts end                      close the session (the app exits)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { type Command, type Driver, dispatch, evidenceLog, locator, runsRoot, sharedCommands } from './commands.ts'

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
const CONTROLS = 'select, input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file]), textarea, button'
const MIN_CONTRAST = 3.0

interface RunEnv {
  run: string
  driverPort: number
  binary: string
  display: string
}

interface WebDriverError {
  error: string
  message: string
}

type WebDriverReply<T> = { value: T | WebDriverError }

const current = join(runsRoot, 'current')
if (!existsSync(join(current, 'env.json'))) {
  console.error(`wd: no active run at ${current}; run "m3d.sh up" first`)
  process.exit(2)
}
const env: RunEnv = JSON.parse(readFileSync(join(current, 'env.json'), 'utf8'))
const base = `http://127.0.0.1:${env.driverPort}`
const evidence = join(env.run, 'evidence')
const sessionFile = join(env.run, 'session')
const log = evidenceLog(evidence)

class DriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function isError(value: unknown): value is WebDriverError {
  return typeof value === 'object' && value !== null && 'error' in value
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: object): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const reply = (await res.json()) as WebDriverReply<T>
  if (isError(reply.value)) throw new DriverError(reply.value.error, `${method} ${path}: ${reply.value.error}: ${reply.value.message}`)
  return reply.value
}

function sid(): string {
  if (!existsSync(sessionFile)) throw new Error('no session; run "wd.ts session" first')
  return readFileSync(sessionFile, 'utf8').trim()
}

async function findAll(sel: string): Promise<string[]> {
  const found = await call<Array<Record<string, string>>>('POST', `/session/${sid()}/elements`, locator(sel))
  return found.map((el) => el[ELEMENT_KEY])
}

// An element that left the DOM between the find and this call reads as hidden. Any
// other driver error propagates, so a dead session fails at once instead of timing out.
async function displayed(id: string): Promise<boolean> {
  return call<boolean>('GET', `/session/${sid()}/element/${id}/displayed`).catch((err: unknown) => {
    if (err instanceof DriverError && (err.code === 'stale element reference' || err.code === 'no such element')) return false
    throw err
  })
}

// The first displayed match, or with `present` the first match at all.
async function waitFor(sel: string, ms = 15000, present = false): Promise<string> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    for (const id of await findAll(sel)) if (present || (await displayed(id))) return id
    await Bun.sleep(250)
  }
  throw new Error(`timed out after ${ms}ms waiting for ${sel}`)
}

type Rgb = readonly [number, number, number]

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Image {
  width: number
  height: number
  channels: 3 | 4
  pixels: Uint8Array
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// Decodes the PNGs WebDriver returns: 8-bit RGB or RGBA, non-interlaced.
// Anything else throws, so a decoder gap never reads as a contrast result.
function decodePng(png: Buffer): Image {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('screenshot is not a PNG')
  let header: { width: number; height: number; channels: 3 | 4 } | undefined
  const idat: Buffer[] = []
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    at += 12 + length
    if (type === 'IHDR') {
      const [depth, colorType, , , interlace] = data.subarray(8, 13)
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG (bit depth ${depth}, color type ${colorType}, interlace ${interlace}); need 8-bit RGB or RGBA, non-interlaced`)
      }
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), channels: colorType === 6 ? 4 : 3 }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (!header) throw new Error('PNG has no IHDR chunk')
  const { width, height, channels } = header
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error(`PNG data is short: ${raw.length} bytes for ${width}x${height}`)
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0
      const b = y > 0 ? pixels[row - stride + x] : 0
      const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0
      const predictor =
        filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : NaN
      if (Number.isNaN(predictor)) throw new Error(`PNG row ${y} has unknown filter ${filter}`)
      pixels[row + x] = (raw[src + x] + predictor) & 0xff
    }
  }
  return { width, height, channels, pixels }
}

// The most common exact RGB value in `box`, inset 2 px per side to skip the border.
function dominantRgb(img: Image, box: Box = { x: 0, y: 0, width: img.width, height: img.height }): Rgb {
  const inset = box.width > 4 && box.height > 4 ? 2 : 0
  const counts = new Map<number, number>()
  for (let y = box.y + inset; y < box.y + box.height - inset; y++) {
    for (let x = box.x + inset; x < box.x + box.width - inset; x++) {
      const i = (y * img.width + x) * img.channels
      const key = (img.pixels[i] << 16) | (img.pixels[i + 1] << 8) | img.pixels[i + 2]
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best = 0
  let bestCount = -1
  for (const [key, count] of counts) if (count > bestCount) [best, bestCount] = [key, count]
  return [(best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff]
}

function parseCssColor(css: string): { rgb: Rgb; alpha: number } {
  const parts = css.match(/^rgba?\(([^)]*)\)$/)?.[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  if (!parts || parts.length < 3 || parts.some(Number.isNaN)) throw new Error(`cannot parse computed color ${JSON.stringify(css)}`)
  return { rgb: [parts[0], parts[1], parts[2]], alpha: parts[3] ?? 1 }
}

function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const mix = (i: 0 | 1 | 2) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))
  return [mix(0), mix(1), mix(2)]
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// WCAG contrast ratio, 1 (same color) to 21 (black on white).
function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// The placeholder's ink: the content-box pixel that contrasts most with the
// background. The content box keeps the rounded border and focus ring out, and the
// sweep hides the caret while it screenshots (CARET_OFF). The most common color is
// no good here: small text antialiases into more mid-tone pixels than core ink. No
// ink at all reads as the background, so an invisible placeholder fails.
function inkRgb(img: Image, box: Box, background: Rgb): Rgb {
  let ink = background
  let best = 1
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = (y * img.width + x) * img.channels
      const rgb: Rgb = [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]
      const ratio = contrastRatio(rgb, background)
      if (ratio > best) [ink, best] = [rgb, ratio]
    }
  }
  return ink
}

// A focused empty field draws a blinking caret whose blended edge could outscore a
// dim placeholder, so the caret is hidden for the one sweep screenshot. Style only:
// focus, value, and events are untouched. A copy left by a killed run is replaced.
const CARET_OFF = `document.getElementById('wd-contrast-caret')?.remove();
const s = document.createElement('style'); s.id = 'wd-contrast-caret';
s.textContent = '* { caret-color: transparent !important; }'; document.head.append(s);
return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))));`
const CARET_ON = `document.getElementById('wd-contrast-caret')?.remove(); return true;`

function deviceBox(css: Box, dpr: number, page: Image): Box {
  const x = Math.max(0, Math.round(css.x * dpr))
  const y = Math.max(0, Math.round(css.y * dpr))
  return {
    x,
    y,
    width: Math.min(page.width, Math.round((css.x + css.width) * dpr)) - x,
    height: Math.min(page.height, Math.round((css.y + css.height) * dpr)) - y,
  }
}

function hex(rgb: Rgb): string {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
}

interface ControlStyle extends Box {
  label: string
  placeholder: boolean
  /** Every color text is painted in: the control's own text (fields, or a direct text node),
   *  then each shown descendant that owns text. aria-hidden icons are decorative and skipped. */
  /** box: for a descendant, the nearest element from it up to the control that paints its own
   *  background, else null; for the control's own ink, the control's box. */
  inks: Array<{ color: string; source: string; box: Box | null }>
  /** The padding box minus padding, in CSS px: where the placeholder text is drawn. */
  content: Box
  color: string
  opacity: number
  dpr: number
}

// An empty field with a placeholder shows the placeholder; the sweep measures it
// from pixels, because WebKit's getComputedStyle(el, '::placeholder') returns the
// field's own color (observed 2026-10-07).
const STYLE_SCRIPT = `const el = arguments[0], cs = getComputedStyle(el), r = el.getBoundingClientRect();
const ph = 'placeholder' in el && el.placeholder !== '' && el.value === '';
const text = (el.tagName === 'SELECT' ? el.selectedOptions[0]?.text ?? '' : el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
const handle = el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('name') || text.slice(0, 30);
const owns = (n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim() !== '');
const box = (n) => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
const paints = (n) => { const m = getComputedStyle(n).backgroundColor.match(/[\\d.]+/g); return m !== null && m.length >= 3 && (m[3] === undefined || Number(m[3]) > 0); };
const surface = (d) => { for (let n = d; n && n !== el; n = n.parentElement) if (paints(n)) return box(n); return null; };
const inks = el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || owns(el) ? [{ color: cs.color, source: '', box: box(el) }] : [];
const shown = (d) => { const ds = getComputedStyle(d); return d.getClientRects().length > 0 && ds.visibility !== 'hidden' && ds.opacity !== '0' && !d.closest('[aria-hidden=true]'); };
for (const d of el.querySelectorAll('*')) if (owns(d) && shown(d))
  inks.push({ color: getComputedStyle(d).color, source: d.tagName.toLowerCase() + (d.classList[0] ? '.' + d.classList[0] : ''), box: surface(d) });
return { label: el.tagName.toLowerCase() + (handle ? ' ' + JSON.stringify(handle) : '') + (ph ? ' (placeholder)' : ''),
  placeholder: ph, color: cs.color, inks, opacity: Number(cs.opacity),
  content: { x: r.x + el.clientLeft + parseFloat(cs.paddingLeft), y: r.y + el.clientTop + parseFloat(cs.paddingTop),
    width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    height: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) },
  x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio };`

interface ContrastResult {
  label: string
  line: string
  ratio: number
  /** Below the minimum but listed in contrast-baseline.txt, a known failure. */
  known: boolean
}

interface Sweep {
  results: ContrastResult[]
  hidden: number
  skipped: number
}

// Known failures: each line is the measured ratio, then the control label. A listed
// control counts as known only while it measures within BASELINE_TOLERANCE of its
// recorded ratio or above it, so a known failure that gets worse fails again. Remove a line when it is fixed.
// Read by the sweep, not at load, so a bad line fails a `shot` only after its PNG is saved.
function readBaseline(): Map<string, number> {
  const baseline = new Map<string, number>()
  for (const raw of readFileSync(join(import.meta.dir, 'contrast-baseline.txt'), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(\d+\.\d+)\s+(.+)$/.exec(line)
    if (!match) throw new Error(`contrast-baseline.txt: expected "<ratio> <label>", got ${JSON.stringify(line)}`)
    const ratio = Number(match[1])
    baseline.set(match[2], Math.min(ratio, baseline.get(match[2]) ?? ratio))
  }
  return baseline
}

// A reading within 0.05 of its record is the same failure: ratios print with two
// decimals, and a placeholder's ink is a raw pixel that antialiasing can nudge. A real
// regression (2.53 down to 1.5) is far outside it.
const BASELINE_TOLERANCE = 0.05

const isNew = (r: ContrastResult) => r.ratio < MIN_CONTRAST && !r.known

function summarize(sel: string, { results, hidden, skipped }: Sweep): string {
  const known = results.filter((r) => r.known).length
  return `contrast ${sel}: ${results.length} checked, ${results.filter(isNew).length} below ${MIN_CONTRAST.toFixed(1)}, ${known} known (contrast-baseline.txt), ${hidden} hidden, ${skipped} skipped (zero size or off screen)`
}

// Measures each displayed match: the CSS text color, blended by its alpha and the
// element opacity, against the background WebKit actually painted. Comparing the
// CSS color (not the darkest or brightest pixel) is what catches a native control
// that drops its CSS background: its own dark arrow would pass a pixel-only check.
// An empty field with a placeholder is the exception: its ink is read from pixels
// (inkRgb), because WebKit does not report the placeholder's computed color.
async function contrastSweep(sel: string): Promise<Sweep> {
  const baseline = readBaseline()
  const results: ContrastResult[] = []
  let hidden = 0
  let skipped = 0
  let page: Image | undefined
  for (const id of await findAll(sel)) {
    if (!(await displayed(id))) {
      hidden++
      continue
    }
    const style = await call<ControlStyle>('POST', `/session/${sid()}/execute/sync`, { script: STYLE_SCRIPT, args: [{ [ELEMENT_KEY]: id }] })
    if (style.width === 0 || style.height === 0) {
      skipped++
      continue
    }
    // Always crop the viewport screenshot. WebKitWebDriver's element screenshot
    // returns black pixels for every control under Xvfb, which hid the white
    // selects this check exists to catch (observed 2026-10-07).
    if (!page) {
      await call('POST', `/session/${sid()}/execute/async`, { script: `const done = arguments[arguments.length - 1]; (async () => { ${CARET_OFF} })().then(done)`, args: [] })
      try {
        page = decodePng(Buffer.from(await call<string>('GET', `/session/${sid()}/screenshot`), 'base64'))
      } finally {
        await call('POST', `/session/${sid()}/execute/sync`, { script: CARET_ON, args: [] })
      }
      const expected = await call<number>('POST', `/session/${sid()}/execute/sync`, { script: 'return Math.round(innerWidth * devicePixelRatio)', args: [] })
      if (page.width !== expected) throw new Error(`screenshot is ${page.width}px wide, expected ${expected} device px; crops would miss`)
    }
    const box = deviceBox(style, style.dpr, page)
    // Displayed but scrolled away: count it, so one off-screen row cannot end the sweep.
    if (box.width <= 0 || box.height <= 0) {
      skipped++
      continue
    }
    const controlBackground = dominantRgb(page, box)
    // A descendant that paints its own background (a tinted badge) is measured on that
    // surface. Every other ink sits on the control's background: a text span's own box
    // is too tight around its glyphs to show the background as its most common color.
    const backgroundOf = (css: Box | null) => {
      const own = css && deviceBox(css, style.dpr, page!)
      return own && own.width > 0 && own.height > 0 ? dominantRgb(page!, own) : controlBackground
    }
    const measure = (css: string, background: Rgb, source: string) => {
      const color = parseCssColor(css)
      const text = blend(color.rgb, background, color.alpha * style.opacity)
      return { text, background, source, ratio: contrastRatio(text, background) }
    }
    // The worst-contrast ink wins: a button's tertiary child span is what a reader sees.
    const inks = style.placeholder
      ? [(() => {
          const text = inkRgb(page, deviceBox(style.content, style.dpr, page), controlBackground)
          return { text, background: controlBackground, source: '', ratio: contrastRatio(text, controlBackground) }
        })()]
      : style.inks.map((ink) => measure(ink.color, backgroundOf(ink.box), ink.source))
    if (inks.length === 0) inks.push(measure(style.color, controlBackground, ''))
    const worst = inks.reduce((a, b) => (b.ratio < a.ratio ? b : a))
    const recorded = baseline.get(style.label)
    const known = worst.ratio < MIN_CONTRAST && recorded !== undefined && worst.ratio >= recorded - BASELINE_TOLERANCE
    const tag = known ? ' (baseline)' : recorded !== undefined ? ` (worse than baseline ${recorded.toFixed(2)})` : ''
    const low = worst.ratio < MIN_CONTRAST ? `  below ${MIN_CONTRAST.toFixed(1)}${tag}` : ''
    const from = worst.source ? ` in ${worst.source}` : ''
    results.push({
      label: style.label,
      ratio: worst.ratio,
      known,
      line: `${style.label}  bg ${hex(worst.background)}  text ${hex(worst.text)}${from}  ratio ${worst.ratio.toFixed(2)}${low}`,
    })
  }
  return { results, hidden, skipped }
}

const driver: Driver = {
  evidence,
  wait: async (sel, ms) => {
    await waitFor(sel, ms)
  },
  click: async (sel) => {
    await call('POST', `/session/${sid()}/element/${await waitFor(sel)}/click`, {})
  },
  text: async (sel) => call<string>('GET', `/session/${sid()}/element/${await waitFor(sel)}/text`),
  count: async (sel) => (await findAll(sel)).length,
  screenshot: async () => Buffer.from(await call<string>('GET', `/session/${sid()}/screenshot`), 'base64'),
  eval: (script) => call<unknown>('POST', `/session/${sid()}/execute/sync`, { script, args: [] }),
}

const shared = sharedCommands(driver)

const commands: Record<string, Command> = {
  ...shared,
  'pointer-click': async ([sel]) => {
    if (!sel) throw new Error('usage: wd.ts pointer-click <sel>')
    const id = await waitFor(sel, 15000, true)
    const point = await call<{ title: string; x: number; y: number } | null>('POST', `/session/${sid()}/execute/sync`, {
      args: [{ [ELEMENT_KEY]: id }],
      script: `const el = arguments[0];
el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
const { left, right, top, bottom } = el.getBoundingClientRect();
const x = (Math.max(left, 0) + Math.min(right, innerWidth)) / 2;
const y = (Math.max(top, 0) + Math.min(bottom, innerHeight)) / 2;
if (!el.contains(document.elementFromPoint(x, y))) return null;
return {
  title: document.title,
  x: Math.round(x * devicePixelRatio),
  y: Math.round(y * devicePixelRatio),
};`,
    })
    if (point === null) throw new Error(`pointer-click ${sel}: the first match has no clickable center`)
    const { title, x, y } = point
    const displayEnv = { ...process.env, DISPLAY: env.display }
    const pattern = `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
    const found = Bun.spawnSync(['xdotool', 'search', '--onlyvisible', '--name', pattern], { env: displayEnv })
    const window = found.stdout.toString().trim()
    if (found.exitCode !== 0 || !/^\d+$/.test(window)) {
      throw new Error(`pointer-click ${sel}: expected one visible X11 window titled ${JSON.stringify(title)} on ${env.display} (xdotool exit ${found.exitCode})`)
    }
    // WebKit's screenX/Y include window decorations. X11 translates from the client area.
    const result = Bun.spawnSync(['xdotool', 'mousemove', '--window', window, String(x), String(y), 'click', '1'], { env: displayEnv })
    if (result.exitCode !== 0) throw new Error(`pointer-click ${sel}: xdotool exited ${result.exitCode}: ${result.stderr.toString().trim()}`)
    const action = `pointer-click ${sel} at ${x},${y} in ${JSON.stringify(title)} on ${env.display}`
    log(action)
    console.log(action)
  },
  session: async () => {
    const created = await call<{ sessionId: string }>('POST', '/session', {
      capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: env.binary } } },
    })
    writeFileSync(sessionFile, created.sessionId)
    log(`session ${created.sessionId} ${env.binary}`)
    console.log(created.sessionId)
  },
  gone: async ([sel, ms]) => {
    const deadline = Date.now() + Number(ms ?? 15000)
    while (Date.now() < deadline) {
      const visible = await Promise.all((await findAll(sel)).map(displayed))
      if (!visible.includes(true)) {
        log(`gone ${sel} ok`)
        return
      }
      await Bun.sleep(250)
    }
    throw new Error(`${sel} still displayed`)
  },
  hover: async ([sel]) => {
    const id = await waitFor(sel, 15000, true)
    await call('POST', `/session/${sid()}/actions`, {
      actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: { [ELEMENT_KEY]: id }, x: 0, y: 0 }] }],
    })
    log(`hover ${sel}`)
  },
  type: async (args) => {
    const [sel, text] = args
    const id = await waitFor(sel)
    if (args.includes('--clear')) await call('POST', `/session/${sid()}/element/${id}/clear`, {})
    // WebDriver rejects an empty value, so `type <sel> '' --clear` only clears.
    if (text) await call('POST', `/session/${sid()}/element/${id}/value`, { text })
    log(`type ${sel} ${JSON.stringify(text)}`)
  },
  'type-secret': async (args) => {
    const [sel, name] = args
    const text = process.env[name ?? '']
    if (!text) throw new Error(`type-secret: environment variable ${name} is empty or unset`)
    const id = await waitFor(sel)
    if (args.includes('--clear')) await call('POST', `/session/${sid()}/element/${id}/clear`, {})
    // A WebDriver error can echo the value it refused, so its text is withheld.
    await call('POST', `/session/${sid()}/element/${id}/value`, { text }).catch(() => {
      throw new Error(`type-secret ${sel}: WebDriver refused the value (details withheld)`)
    })
    log(`type-secret ${sel} $${name} (${text.length} chars)`)
  },
  keys: async ([text]) => {
    const active = await call<Record<string, string>>('GET', `/session/${sid()}/element/active`)
    await call('POST', `/session/${sid()}/element/${active[ELEMENT_KEY]}/value`, { text })
    log(`keys ${JSON.stringify(text)}`)
  },
  attr: async ([sel, name]) => {
    const id = await waitFor(sel, 15000, true)
    const value = await call<unknown>('GET', `/session/${sid()}/element/${id}/property/${name}`)
    log(`attr ${sel} ${name} => ${JSON.stringify(value)}`)
    console.log(typeof value === 'string' ? value : JSON.stringify(value))
  },
  shot: async (args) => {
    await shared.shot(args)
    const failing = (await contrastSweep(CONTROLS)).results.filter(isNew)
    log(`shot contrast: ${failing.length} controls below ${MIN_CONTRAST.toFixed(1)} outside the baseline`)
    if (failing.length > 0) {
      console.error(`contrast: ${failing.length} controls below ${MIN_CONTRAST.toFixed(1)} outside the baseline`)
      for (const { line } of failing) {
        log(`shot contrast ${line}`)
        console.error(`  ${line}`)
      }
    }
  },
  contrast: async ([sel = CONTROLS]) => {
    const sweep = await contrastSweep(sel)
    for (const { line } of sweep.results) {
      log(`contrast ${line}`)
      console.log(line)
    }
    const summary = summarize(sel, sweep)
    log(summary)
    console.log(summary)
    if (sweep.results.some(isNew)) process.exitCode = 1
  },
  'eval-secret': async ([script]) => {
    // Neither the script nor a script error is logged: either can hold the secret.
    const value = await call<unknown>('POST', `/session/${sid()}/execute/sync`, { script, args: [] }).catch(() => {
      throw new Error('eval-secret: the script failed (details withheld)')
    })
    const out = typeof value === 'string' ? value : JSON.stringify(value)
    log(`eval-secret => (${out.length} chars, not logged)`)
    console.log(out)
  },
  note: async (args) => {
    log(`note ${args.join(' ')}`)
  },
  end: async () => {
    await call('DELETE', `/session/${sid()}`)
    log('end')
  },
}

dispatch(
  commands,
  process.argv.slice(2),
  'usage: wd.ts session|wait|gone|click|pointer-click|hover|type|type-secret|keys|text|attr|count|shot|contrast|eval|eval-secret|note|end (see header)',
).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  const [cmd, ...rest] = process.argv.slice(2)
  // eval-secret's script can hold a secret, so its failure line names the command alone.
  log(`FAIL ${cmd === 'eval-secret' ? cmd : [cmd, ...rest].join(' ')} :: ${message}`)
  console.error(`wd: ${message}`)
  process.exit(1)
})
