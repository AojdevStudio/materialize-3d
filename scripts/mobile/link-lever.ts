/**
 * The computer for the mobile reconnect proof: the real sidecar with scripted models, serving one chat to phones, and a
 * link proxy in front of its phone service that a UI test can take down and bring back.
 *
 *   bun scripts/mobile/link-lever.ts <out-dir> <tailnet-host> [proxy-port] [control-port]
 *
 * Tailscale Serve must forward https://<tailnet-host>:<proxy-port> to http://127.0.0.1:<proxy-port>. A stand-in
 * `tailscale` on the sidecar's PATH reports that entry as forwarding to the sidecar's own phone port, so the pairing QR
 * names the proxy. It writes <out-dir>/pairing.svg and, on macOS, pairing.png for `simctl addmedia`. It runs until
 * stopped.
 *
 * The control port answers on loopback only:
 *   GET /down            ends the open event streams and answers 502 until /up
 *   GET /up              forwards again
 *   GET /drop-next-send  forwards the next POST .../send, lets the computer accept it, then answers 502 and goes down
 *   GET /log             every request the proxy saw, as JSON lines "METHOD /path"
 *   GET /clear-log       empties the log
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, ChatView, MobilePairing } from '../../sidecar/src/protocol'
import { spawnSidecar } from '../../sidecar/test/sidecar'

const [out, host, proxyArg = '47391', controlArg = '47392'] = process.argv.slice(2)
if (out === undefined || host === undefined) throw new Error('usage: bun scripts/mobile/link-lever.ts <out-dir> <tailnet-host> [proxy-port] [control-port]')
const proxyPort = Number(proxyArg)
const controlPort = Number(controlArg)
mkdirSync(out, { recursive: true })

/** A free loopback port for the sidecar's phone service. */
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
const phonePort = probe.port
await probe.stop(true)

const dir = mkdtempSync(join(tmpdir(), 'm3d-link-lever-'))
const bin = join(dir, 'bin')
mkdirSync(bin)
const served = `${host}:${proxyPort}`
const serve = { TCP: { [proxyPort]: { HTTPS: true } }, Web: { [served]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${phonePort}` } } } } }
writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\n[ "$*" = "serve status --json" ] || exit 64\necho '${JSON.stringify(serve)}'\n`)
writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
for (const tool of ['tailscale', 'uv']) chmodSync(join(bin, tool), 0o755)

const projects = join(dir, 'projects')
const app = spawnSidecar(join(dir, 'state'), projects, new Map(), {
  script: 'models',
  env: { PATH: `${bin}:${process.env.PATH}`, M3D_MOBILE_PORT: String(phonePort), M3D_PAIRING_TTL_MS: String(60 * 60_000) },
})
await app.next()
await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
const { project } = await app.sendDraft('new', 'Desk cable clip')
for (;;) {
  const view = (await app.call('chat.open', { project })) as ChatView
  if (!view.running && view.entries.some((e: ChatEntry) => e.kind === 'assistant')) break
  await Bun.sleep(200)
}
// Two model files, so the chat lists them, each a small tetrahedron the viewer can draw.
const tetra = (name: string) =>
  `solid ${name}\n${[
    [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
    [[0, 0, 0], [0, 0, 10], [10, 0, 0]],
    [[0, 0, 0], [0, 10, 0], [0, 0, 10]],
    [[10, 0, 0], [0, 0, 10], [0, 10, 0]],
  ]
    .map((face) => `facet normal 0 0 0\nouter loop\n${face.map((v) => `vertex ${v.join(' ')}`).join('\n')}\nendloop\nendfacet`)
    .join('\n')}\nendsolid ${name}\n`
writeFileSync(join(projects, project, 'clip.stl'), tetra('clip'))
writeFileSync(join(projects, project, 'base.stl'), tetra('base'))

const pairing = (await app.call('mobile.pair')) as MobilePairing
if (pairing.kind !== 'ready') throw new Error(`pairing is ${pairing.kind}: ${JSON.stringify(pairing)}`)
writeFileSync(join(out, 'pairing.svg'), pairing.svg)
// The link the QR holds, for a client that pairs without a camera. It works once.
writeFileSync(join(out, 'pairing.url'), pairing.url)
if (process.platform === 'darwin') {
  const render = Bun.spawnSync(['qlmanage', '-t', '-s', '1000', '-o', out, join(out, 'pairing.svg')], { stdout: 'pipe', stderr: 'pipe' })
  if (render.exitCode !== 0) throw new Error(`qlmanage could not draw the QR: ${render.stderr.toString()}`)
  Bun.spawnSync(['mv', join(out, 'pairing.svg.png'), join(out, 'pairing.png')])
}

let up = true
let dropNextSend = false
const log: string[] = []
const streams = new Set<AbortController>()
const down = () => {
  up = false
  for (const stream of streams) stream.abort()
  streams.clear()
}

const proxy = Bun.serve({
  hostname: '127.0.0.1',
  port: proxyPort,
  // An event stream stays open with nothing but its keepalive for 15 s at a time.
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    log.push(`${request.method} ${url.pathname}`)
    if (!up) return new Response('The link is down.', { status: 502 })
    const upstream = new AbortController()
    const headers = new Headers(request.headers)
    headers.delete('host')
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
    const answer = await fetch(`http://127.0.0.1:${phonePort}${url.pathname}${url.search}`, { method: request.method, headers, body, signal: upstream.signal })
    if (request.method === 'POST' && url.pathname.endsWith('/send') && dropNextSend) {
      dropNextSend = false
      // The computer took the send. Its answer never reaches the phone.
      await answer.arrayBuffer()
      down()
      return new Response('The link dropped before the answer.', { status: 502 })
    }
    if (url.pathname === '/api/v1/events') {
      streams.add(upstream)
      // The phone that leaves a stream ends it upstream too.
      request.signal.addEventListener('abort', () => {
        streams.delete(upstream)
        upstream.abort()
      })
    }
    return new Response(answer.body, { status: answer.status, headers: answer.headers })
  },
})

const control = Bun.serve({
  hostname: '127.0.0.1',
  port: controlPort,
  fetch: (request) => {
    switch (new URL(request.url).pathname) {
      case '/down':
        down()
        return new Response('down')
      case '/up':
        up = true
        return new Response('up')
      case '/drop-next-send':
        dropNextSend = true
        return new Response('armed')
      case '/log':
        return Response.json(log)
      case '/clear-log':
        log.length = 0
        return new Response('cleared')
      default:
        return new Response('no such command', { status: 404 })
    }
  },
})

// The name the phone shows for this computer, as the phone service reports it.
console.log(JSON.stringify({ ready: true, computer: hostname().replace(/\.local$/, ''), chat: 'Desk cable clip', project, phonePort, proxy: proxy.port, control: control.port, url: pairing.url.replace(/code=.*/, 'code=…') }))

const stop = async () => {
  void proxy.stop(true)
  void control.stop(true)
  await app.quit()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
