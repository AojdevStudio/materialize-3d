#!/usr/bin/env bun
// WebDriver client for the Materialize 3D verification run started by m3d.sh.
// Talks raw W3C WebDriver to tauri-driver, which launches the real Tauri binary
// through WebKitWebDriver. Every command is appended to <run>/evidence/actions.log
// so a proof records the action next to the resulting state.
//
// Selectors: plain CSS by default, `xpath=<expr>` for XPath, and `text=<label>`
// for the innermost element whose normalized text equals <label>.
//
//   bun wd.ts session                  start the app (one session per run)
//   bun wd.ts wait <sel> [ms]          wait until <sel> is displayed (default 15000)
//   bun wd.ts gone <sel> [ms]          wait until <sel> is absent or hidden
//   bun wd.ts click <sel>
//   bun wd.ts hover <sel>              move the pointer over <sel> (reveals hover-only controls)
//   bun wd.ts type <sel> <text> [--clear]
//   bun wd.ts keys <text>              send keys to the focused element ( = Enter)
//   bun wd.ts text <sel>               print visible text
//   bun wd.ts attr <sel> <name>        print a DOM property of the first match (visible or not)
//   bun wd.ts count <sel>              print the number of matches
//   bun wd.ts shot <name>              save evidence/<NN>-<name>.png of the webview, then run
//                                      the contrast sweep and report failures on stderr (exit 0)
//   bun wd.ts contrast [sel]           text contrast of each displayed control, measured against its
//                                      rendered pixels; exit 1 if any is below 3.0
//                                      (default: text-bearing controls; checkboxes and radios carry no text)
//   bun wd.ts eval <js>                run a script (`return ...`), print JSON; inspection only
//   bun wd.ts note <message>           append a free-form line to actions.log
//   bun wd.ts end                      close the session (the app exits)

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
const CONTROLS = 'select, input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file]), textarea, button'
const MIN_CONTRAST = 3.0

interface RunEnv {
  run: string
  driverPort: number
  binary: string
}

interface WebDriverError {
  error: string
  message: string
}

type WebDriverReply<T> = { value: T | WebDriverError }

const runsRoot = process.env.M3D_RUNS ?? join(process.env.HOME ?? '', 'm3d-verify')
const current = join(runsRoot, 'current')
if (!existsSync(join(current, 'env.json'))) {
  console.error(`wd: no active run at ${current}; run "m3d.sh up" first`)
  process.exit(2)
}
const env: RunEnv = JSON.parse(readFileSync(join(current, 'env.json'), 'utf8'))
const base = `http://127.0.0.1:${env.driverPort}`
const evidence = join(env.run, 'evidence')
const sessionFile = join(env.run, 'session')

function log(line: string): void {
  appendFileSync(join(evidence, 'actions.log'), `${new Date().toISOString()} ${line}\n`)
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
  if (isError(reply.value)) throw new Error(`${method} ${path}: ${reply.value.error}: ${reply.value.message}`)
  return reply.value
}

function sid(): string {
  if (!existsSync(sessionFile)) throw new Error('no session; run "wd.ts session" first')
  return readFileSync(sessionFile, 'utf8').trim()
}

function locator(sel: string): { using: string; value: string } {
  if (sel.startsWith('xpath=')) return { using: 'xpath', value: sel.slice(6) }
  if (sel.startsWith('text=')) {
    const label = JSON.stringify(sel.slice(5)).replaceAll('"', "'")
    return { using: 'xpath', value: `//*[normalize-space(.)=${label}][not(*[normalize-space(.)=${label}])]` }
  }
  return { using: 'css selector', value: sel }
}

async function findAll(sel: string): Promise<string[]> {
  const found = await call<Array<Record<string, string>>>('POST', `/session/${sid()}/elements`, locator(sel))
  return found.map((el) => el[ELEMENT_KEY])
}

async function displayed(id: string): Promise<boolean> {
  return call<boolean>('GET', `/session/${sid()}/element/${id}/displayed`).catch(() => false)
}

// Resolves to the first match (the first displayed one unless `present` is set),
// polling until the deadline.
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

// Parses a computed `rgb()`/`rgba()` color into RGB plus alpha.
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

function hex(rgb: Rgb): string {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
}

interface ControlStyle extends Box {
  label: string
  color: string
  opacity: number
  dpr: number
}

const STYLE_SCRIPT = `const el = arguments[0], cs = getComputedStyle(el), r = el.getBoundingClientRect();
const text = (el.tagName === 'SELECT' ? el.selectedOptions[0]?.text ?? '' : el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
const handle = el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('name') || text.slice(0, 30);
return { label: el.tagName.toLowerCase() + (handle ? ' ' + JSON.stringify(handle) : ''), color: cs.color, opacity: Number(cs.opacity),
  x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio };`

interface ContrastResult {
  line: string
  ratio: number
}

// Measures each displayed match: the CSS text color, blended by its alpha and the
// element opacity, against the background WebKit actually painted. Comparing the
// CSS color (not the darkest or brightest pixel) is what catches a native control
// that drops its CSS background: its own dark arrow would pass a pixel-only check.
async function contrastSweep(sel: string): Promise<{ results: ContrastResult[]; skipped: number }> {
  const results: ContrastResult[] = []
  let skipped = 0
  let page: Image | undefined
  for (const id of await findAll(sel)) {
    if (!(await displayed(id))) continue
    const style = await call<ControlStyle>('POST', `/session/${sid()}/execute/sync`, { script: STYLE_SCRIPT, args: [{ [ELEMENT_KEY]: id }] })
    if (style.width === 0 || style.height === 0) {
      skipped++
      continue
    }
    // Always crop the viewport screenshot. WebKitWebDriver's element screenshot
    // returns black pixels for every control under Xvfb, which hid the white
    // selects this check exists to catch (observed 2026-10-07).
    if (!page) {
      page = decodePng(Buffer.from(await call<string>('GET', `/session/${sid()}/screenshot`), 'base64'))
      const expected = await call<number>('POST', `/session/${sid()}/execute/sync`, { script: 'return Math.round(innerWidth * devicePixelRatio)', args: [] })
      if (page.width !== expected) throw new Error(`screenshot is ${page.width}px wide, expected ${expected} device px; crops would miss`)
    }
    const x = Math.max(0, Math.round(style.x * style.dpr))
    const y = Math.max(0, Math.round(style.y * style.dpr))
    const box = {
      x,
      y,
      width: Math.min(page.width, Math.round((style.x + style.width) * style.dpr)) - x,
      height: Math.min(page.height, Math.round((style.y + style.height) * style.dpr)) - y,
    }
    // Displayed but scrolled away: count it, so one off-screen row cannot end the sweep.
    if (box.width <= 0 || box.height <= 0) {
      skipped++
      continue
    }
    const background = dominantRgb(page, box)
    const color = parseCssColor(style.color)
    const text = blend(color.rgb, background, color.alpha * style.opacity)
    const ratio = contrastRatio(text, background)
    const low = ratio < MIN_CONTRAST ? `  below ${MIN_CONTRAST.toFixed(1)}` : ''
    results.push({ ratio, line: `${style.label}  bg ${hex(background)}  text ${hex(text)}  ratio ${ratio.toFixed(2)}${low}` })
  }
  return { results, skipped }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case 'session': {
      const created = await call<{ sessionId: string }>('POST', '/session', {
        capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: env.binary } } },
      })
      writeFileSync(sessionFile, created.sessionId)
      log(`session ${created.sessionId} ${env.binary}`)
      console.log(created.sessionId)
      return
    }
    case 'wait': {
      await waitFor(args[0], Number(args[1] ?? 15000))
      log(`wait ${args[0]} ok`)
      return
    }
    case 'gone': {
      const deadline = Date.now() + Number(args[1] ?? 15000)
      while (Date.now() < deadline) {
        const visible = await Promise.all((await findAll(args[0])).map(displayed))
        if (!visible.includes(true)) {
          log(`gone ${args[0]} ok`)
          return
        }
        await Bun.sleep(250)
      }
      throw new Error(`${args[0]} still displayed`)
    }
    case 'click': {
      const id = await waitFor(args[0])
      await call('POST', `/session/${sid()}/element/${id}/click`, {})
      log(`click ${args[0]}`)
      return
    }
    case 'hover': {
      const id = await waitFor(args[0], 15000, true)
      await call('POST', `/session/${sid()}/actions`, {
        actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: { [ELEMENT_KEY]: id }, x: 0, y: 0 }] }],
      })
      log(`hover ${args[0]}`)
      return
    }
    case 'type': {
      const [sel, text] = args
      const id = await waitFor(sel)
      if (args.includes('--clear')) await call('POST', `/session/${sid()}/element/${id}/clear`, {})
      await call('POST', `/session/${sid()}/element/${id}/value`, { text })
      log(`type ${sel} ${JSON.stringify(text)}`)
      return
    }
    case 'keys': {
      const active = await call<Record<string, string>>('GET', `/session/${sid()}/element/active`)
      await call('POST', `/session/${sid()}/element/${active[ELEMENT_KEY]}/value`, { text: args[0] })
      log(`keys ${JSON.stringify(args[0])}`)
      return
    }
    case 'text': {
      const id = await waitFor(args[0])
      const text = await call<string>('GET', `/session/${sid()}/element/${id}/text`)
      log(`text ${args[0]} => ${JSON.stringify(text)}`)
      console.log(text)
      return
    }
    case 'attr': {
      const id = await waitFor(args[0], 15000, true)
      const value = await call<unknown>('GET', `/session/${sid()}/element/${id}/property/${args[1]}`)
      log(`attr ${args[0]} ${args[1]} => ${JSON.stringify(value)}`)
      console.log(typeof value === 'string' ? value : JSON.stringify(value))
      return
    }
    case 'count': {
      const n = (await findAll(args[0])).length
      log(`count ${args[0]} => ${n}`)
      console.log(n)
      return
    }
    case 'shot': {
      const png = await call<string>('GET', `/session/${sid()}/screenshot`)
      const n = readdirSync(evidence).filter((f) => f.endsWith('.png')).length + 1
      const file = join(evidence, `${String(n).padStart(2, '0')}-${args[0]}.png`)
      writeFileSync(file, Buffer.from(png, 'base64'))
      log(`shot ${file}`)
      console.log(file)
      // Evidence capture stays exit 0; contrast failures are reported, not thrown.
      try {
        const failing = (await contrastSweep(CONTROLS)).results.filter((r) => r.ratio < MIN_CONTRAST)
        log(`shot contrast: ${failing.length} controls below ${MIN_CONTRAST.toFixed(1)}`)
        if (failing.length > 0) {
          console.error(`contrast: ${failing.length} controls below ${MIN_CONTRAST.toFixed(1)}`)
          for (const { line } of failing) {
            log(`shot contrast ${line}`)
            console.error(`  ${line}`)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log(`shot contrast sweep failed :: ${message}`)
        console.error(`contrast: sweep failed: ${message}`)
      }
      return
    }
    case 'contrast': {
      const sel = args[0] ?? CONTROLS
      const { results, skipped } = await contrastSweep(sel)
      const failing = results.filter((r) => r.ratio < MIN_CONTRAST).length
      for (const { line } of results) {
        log(`contrast ${line}`)
        console.log(line)
      }
      const summary = `contrast ${sel}: ${results.length} checked, ${failing} below ${MIN_CONTRAST.toFixed(1)}, ${skipped} skipped (zero size or off screen)`
      log(summary)
      console.log(summary)
      if (failing > 0) process.exitCode = 1
      return
    }
    case 'eval': {
      const value = await call<unknown>('POST', `/session/${sid()}/execute/sync`, { script: args[0], args: [] })
      log(`eval ${JSON.stringify(args[0])} => ${JSON.stringify(value)}`)
      console.log(JSON.stringify(value, null, 2))
      return
    }
    case 'note': {
      log(`note ${args.join(' ')}`)
      return
    }
    case 'end': {
      await call('DELETE', `/session/${sid()}`)
      log('end')
      return
    }
    default:
      console.error('usage: wd.ts session|wait|gone|click|hover|type|keys|text|attr|count|shot|contrast|eval|note|end (see header)')
      process.exit(2)
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  log(`FAIL ${process.argv.slice(2).join(' ')} :: ${message}`)
  console.error(`wd: ${message}`)
  process.exit(1)
})
