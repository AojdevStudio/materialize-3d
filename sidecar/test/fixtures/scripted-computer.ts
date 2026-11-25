/**
 * A paired computer for the phone and tablet layout proof: the real sidecar with scripted models
 * (`scripted-sidecar.ts` beside this file), serving phones on `--port`. It makes one chat whose lead, GPT 6 Astra,
 * handed a task to its helper, GPT 6.3 Sol, copies each `--model` file into that chat's folder, and writes the pairing
 * QR as a PNG to `--qr`. Then it runs until stopped, so a phone can change the roles and send the next message, which
 * the same scripted lead hands to the new helper.
 *
 *   bun sidecar/test/fixtures/scripted-computer.ts --port 47381 --qr <pair-qr.png> [--model <file>]... [--serve <host>] [--dir <dir>]
 *
 * Tailscale Serve must forward `https://<host>:<port>` to `http://127.0.0.1:<port>`, since the sidecar reads that to
 * make the code. `--serve <host>` stands in a `tailscale` that says so, for a browser that calls the port directly.
 * `--dir` keeps the store and the project folders there, in `state/` and `projects/`, for the desktop app to open
 * after this stops. It marks setup done, so the desktop opens the studio. It prints one JSON line: the chat's id and
 * title, and the pairing link.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { deflateSync } from 'node:zlib'
import { encode } from 'uqr'
import type { ChatView, MobilePairing } from '../../src/protocol'
import { spawnSidecar } from '../sidecar'

const { values } = parseArgs({
  options: { port: { type: 'string' }, qr: { type: 'string' }, model: { type: 'string', multiple: true, default: [] }, serve: { type: 'string' }, dir: { type: 'string' } },
})
if (values.port === undefined || values.qr === undefined) throw new Error('--port and --qr are required')
const port = values.port

const ASTRA = { provider: 'openai-codex', modelId: 'gpt-6-astra' }
const SOL = { provider: 'openai-codex', modelId: 'gpt-6.3-sol' }
/** The task the scripted helper does: it writes its model id to `helper.txt` and says it drew it. */
const DRAW = 'Draw it as an HTML page.'

// Absolute, since the sidecar runs from its own folder.
const dir = values.dir === undefined ? mkdtempSync(join(tmpdir(), 'm3d-scripted-computer-')) : resolve(values.dir)
const bin = join(dir, 'bin')
mkdirSync(bin, { recursive: true })
const tools: Record<string, string> = { uv: '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n' }
if (values.serve !== undefined) {
  const served = `${values.serve}:${port}`
  const status = { TCP: { [port]: { HTTPS: true } }, Web: { [served]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } }
  tools.tailscale = `#!/bin/sh\n[ "$*" = "serve status --json" ] || exit 64\necho '${JSON.stringify(status)}'\n`
}
for (const [name, body] of Object.entries(tools)) {
  writeFileSync(join(bin, name), body)
  chmodSync(join(bin, name), 0o755)
}
const projects = join(dir, 'projects')
const app = spawnSidecar(join(dir, 'state'), projects, new Map(), {
  script: 'helper',
  env: { PATH: `${bin}:${process.env.PATH}`, M3D_MOBILE_PORT: port, M3D_PAIRING_TTL_MS: String(30 * 60_000) },
})
await app.next()

/** Waits until the chat holds an answer with this text and its turn has ended. */
async function answered(project: string, text: string) {
  const done = (view: ChatView) => !view.running && view.entries.some((e) => e.kind === 'assistant' && e.text === text)
  while (!done((await app.call('chat.open', { project })) as ChatView)) {
    // A chat event carries only the entries added since the last one, so the event that ends the turn may not repeat
    // the answer. Any event of this chat wakes the whole read, which decides.
    await app.until((event) => event.type === 'chat' && event.project === project, 30_000)
  }
}

await app.call('setup.set', { step: 'ready', done: true })
// The scripted OpenAI Codex answers once a key is saved, so both roles offer its GPT 6 Astra and GPT 6.3 Sol.
await app.call('auth.setKey', { provider: 'openai-codex', key: 'scripted' })
await app.call('settings.set', { model: ASTRA })
const { project } = await app.sendDraft('new', 'make the project')
await answered(project, 'made')
await app.call('projects.setHelper', { project, model: SOL })
await app.sendDraft(project, `ask: ${DRAW}`)
await answered(project, 'parent saw: gpt-6.3-sol drew it')
for (const model of values.model) copyFileSync(model, join(projects, project, basename(model)))

const pairing = (await app.call('mobile.pair')) as MobilePairing
if (pairing.kind !== 'ready') throw new Error(`the sidecar cannot pair a phone: ${JSON.stringify(pairing)}`)
writeFileSync(values.qr, qrPng(pairing.url))
const { title } = ((await app.call('state.get')) as { projects: { id: string; title: string }[] }).projects.find((p) => p.id === project) ?? { title: '' }
console.log(JSON.stringify({ project, title, pairUrl: pairing.url }))

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void app.quit().then(() => process.exit(0)))

/** A black-on-white PNG of the QR code for `text`, 8 pixels a module, with the 4-module quiet zone the spec asks for. */
function qrPng(text: string): Buffer {
  const { data, size } = encode(text, { border: 4 })
  const scale = 8
  const side = size * scale
  // Each row of pixels starts with its filter byte, 0 for none, which the zeroed buffer already holds.
  const rows = Buffer.alloc((side + 1) * side)
  data.forEach((modules, my) =>
    modules.forEach((dark, mx) => {
      for (let y = my * scale; y < (my + 1) * scale; y++) rows.fill(dark ? 0 : 255, y * (side + 1) + 1 + mx * scale, y * (side + 1) + 1 + (mx + 1) * scale)
    }),
  )
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])))
    return Buffer.concat([head, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header.set([8, 0, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
