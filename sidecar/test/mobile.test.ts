import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handlers, type Services } from '../src/methods'
import type { ChatEntry, ChatView, MobileChat, MobilePairing, ModelFile, PairedDevice, StoredState } from '../src/protocol'
import { spawnSidecar } from './sidecar'

type App = ReturnType<typeof spawnSidecar>

const HOST = 'computer.tail0000.ts.net'
/** Another service Tailscale Serve already forwards, which pairing must pass over. */
const OTHER = { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } }
const forwarding = (port: number, served = `${HOST}:${port}`) => ({
  TCP: { 443: { HTTPS: true }, [served.slice(served.lastIndexOf(':') + 1)]: { HTTPS: true } },
  Web: { ...OTHER, [served]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
})
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const { port } = probe
  await probe.stop(true)
  if (port === undefined) throw new Error('no free port')
  return port
}

/**
 * A sidecar whose phone service listens on a free port, and a `tailscale` on its PATH that prints `serve` as its
 * Serve config, which `setServe` changes.
 */
async function start(serve: (port: number) => object, env: Record<string, string> = {}, rust: Pick<NonNullable<Parameters<typeof spawnSidecar>[3]>, 'hold'> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-mobile-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
  const config = join(dir, 'serve.json')
  // Like the Mac app's executable, it answers as the command line only with TAILSCALE_BE_CLI set.
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\n[ "$TAILSCALE_BE_CLI" = 1 ] || exit 65\n[ "$*" = "serve status --json" ] || exit 64\ncat '${config}'\n`)
  for (const tool of ['uv', 'tailscale']) chmodSync(join(bin, tool), 0o755)
  const port = await freePort()
  const setServe = (value: object) => writeFileSync(config, JSON.stringify(value))
  setServe(serve(port))
  const projects = join(dir, 'projects')
  const app = spawnSidecar(join(dir, 'state'), projects, new Map(), {
    script: 'models',
    env: { PATH: `${bin}:${process.env.PATH}`, M3D_MOBILE_PORT: String(port), ...env },
    ...rust,
  })
  await app.next()
  await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
  const base = `http://127.0.0.1:${port}/api/v1`
  return { app, dir, port, projects, base, setServe }
}

const pairing = async (app: App) => (await app.call('mobile.pair')) as MobilePairing

async function code(app: App): Promise<string> {
  const shown = await pairing(app)
  if (shown.kind !== 'ready') throw new Error(`pairing is ${shown.kind}`)
  const found = new URL(shown.url).searchParams.get('code')
  if (found === null) throw new Error(`no code in ${shown.url}`)
  return found
}

const redeem = (base: string, code: string, name = 'iPhone') => fetch(`${base}/pair`, { method: 'POST', body: JSON.stringify({ code, name }) })

async function pair(app: App, base: string) {
  const answer = await redeem(base, await code(app))
  expect(answer.status).toBe(200)
  return (await answer.json()) as { token: string; device: PairedDevice; computer: { id: string; name: string; version: string } }
}

/** Calls the service as the device with this token. */
const as =
  (base: string, token: string) =>
  (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}` },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

/** Waits until the chat holds this answer and its turn has ended. */
async function settled(app: App, project: string, text: string) {
  const done = (view: { entries: ChatEntry[]; running: boolean }) => !view.running && view.entries.some((e) => e.kind === 'assistant' && e.text === text)
  if (done((await app.call('chat.open', { project })) as ChatView)) return
  for (;;) {
    await app.until((event) => event.type === 'chat' && event.project === project && (event.entries as ChatEntry[]).some((e) => e.kind === 'assistant' && e.text === text), 30_000)
    if (done((await app.call('chat.open', { project })) as ChatView)) return
  }
}

/** A chat with one finished turn, made from the computer. */
async function chat(app: App): Promise<string> {
  const { project } = await app.sendDraft('new', 'make the project')
  await settled(app, project, 'made')
  return project
}

/** Reads a `text/event-stream` answer, each `data:` line as one event. */
function eventStream(response: Response) {
  if (response.body === null) throw new Error('no stream')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const events: Record<string, unknown>[] = []
  let buffered = ''
  const until = async (match: (event: Record<string, unknown>) => boolean, ms = 30_000) => {
    const deadline = Date.now() + ms
    for (let at = 0; ; ) {
      for (; at < events.length; at++) {
        const event = events[at]
        if (event !== undefined && match(event)) return event
      }
      const read = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => 'timeout' as const)])
      if (read === 'timeout') throw new Error('no matching event in time')
      if (read.done) throw new Error('the stream ended')
      buffered += read.value
      for (let end = buffered.indexOf('\n\n'); end >= 0; end = buffered.indexOf('\n\n')) {
        for (const line of buffered.slice(0, end).split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice('data: '.length)))
        buffered = buffered.slice(end + 2)
      }
    }
  }
  return { events, until, close: () => reader.cancel() }
}

const devices = async (app: App) => (await app.call('mobile.devices')) as PairedDevice[]

describe('pairing', () => {
  test('an expired code cannot pair', async () => {
    const { app, base } = await start(forwarding, { M3D_PAIRING_TTL_MS: '200' })
    const expired = await code(app)
    await Bun.sleep(400)
    const answer = await redeem(base, expired)
    expect(answer.status).toBe(403)
    expect(await devices(app)).toEqual([])
    await app.quit()
  })

  test('a used code cannot pair again, and gets the same answer as a wrong one', async () => {
    const { app, base } = await start(forwarding)
    const once = await code(app)
    const [first, second] = await Promise.all([redeem(base, once, 'iPhone'), redeem(base, once, 'iPad')])
    expect([first.status, second.status].sort()).toEqual([200, 403])
    const again = await redeem(base, once)
    const wrong = await redeem(base, 'not-the-code')
    // A pairing request comes before any token, so a large one is refused before it is read whole.
    expect((await fetch(`${base}/pair`, { method: 'POST', body: JSON.stringify({ code: 'x'.repeat(10_000), name: 'iPhone' }) })).status).toBe(413)
    expect([again.status, wrong.status]).toEqual([403, 403])
    expect(await again.json()).toEqual(await wrong.json())
    expect(await devices(app)).toHaveLength(1)
    await app.quit()
  })

  test('answers setup until Serve forwards to the service, then a QR of its address', async () => {
    const { app, port, setServe } = await start(() => ({}))
    expect(await pairing(app)).toEqual({ kind: 'setup', command: `tailscale serve --bg --https=${port} http://127.0.0.1:${port}` })
    setServe({ Web: OTHER })
    expect((await pairing(app)).kind).toBe('setup')
    // A plain HTTP listener cannot answer the https address a QR would name.
    setServe({ TCP: { [port]: { HTTP: true } }, Web: forwarding(port).Web })
    expect((await pairing(app)).kind).toBe('setup')
    // Tailscale prefers a longer mount, so an address that sends any path elsewhere could take the code or a token.
    const served = forwarding(port)
    const key = `${HOST}:${port}`
    setServe({ ...served, Web: { ...served.Web, [key]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` }, '/api/': { Proxy: 'http://127.0.0.1:9' } } } } })
    // Setting `/` again on that port cannot help, so the command names a port of the app's own, which nothing serves.
    const shared = await pairing(app)
    expect(shared).toEqual({ kind: 'setup', reason: expect.stringContaining('other services'), command: `tailscale serve --bg --https=${port + 1} http://127.0.0.1:${port}` })
    // A port a terminal's own `tailscale serve` holds is taken too.
    const sharedWeb = { ...served.Web, [key]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` }, '/api/': { Proxy: 'http://127.0.0.1:9' } } } }
    setServe({ ...served, Web: sharedWeb, Foreground: { session: { TCP: { [port + 1]: { HTTPS: true } } } } })
    expect(await pairing(app)).toMatchObject({ kind: 'setup', command: `tailscale serve --bg --https=${port + 2} http://127.0.0.1:${port}` })
    // With no port free near it, Settings says so rather than naming one.
    const every = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [port + n, { HTTPS: true }]))
    setServe({ ...served, TCP: { ...served.TCP, ...every }, Web: sharedWeb })
    expect(await pairing(app)).toMatchObject({ kind: 'off', detail: expect.stringContaining('is taken') })
    // Funnel makes the address public, so no code is shown for it.
    setServe({ ...served, AllowFunnel: { [key]: true } })
    const funnel = await pairing(app)
    expect([funnel.kind, funnel.kind === 'off' && funnel.detail.includes('Funnel')]).toEqual(['off', true])
    // A private address wins over a public one listed before it.
    const open = `${HOST}:443`
    const root = { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } }
    setServe({ TCP: { 443: { HTTPS: true }, [port]: { HTTPS: true } }, AllowFunnel: { [open]: true }, Web: { [open]: root, [key]: root } })
    const both = await pairing(app)
    expect(both.kind === 'ready' && both.url.startsWith(`https://${key}/pair?code=`)).toBe(true)

    setServe(forwarding(port))
    const ready = await pairing(app)
    if (ready.kind !== 'ready') throw new Error(`pairing is ${ready.kind}`)
    expect(ready.url).toMatch(new RegExp(`^https://${HOST}:${port}/pair\\?code=[A-Za-z0-9_-]{22}$`))
    expect(ready.svg).toStartWith('<svg')
    expect(ready.expiresMs).toBeGreaterThan(Date.now())

    // Served on the default HTTPS port, the address names no port.
    setServe(forwarding(port, `${HOST}:443`))
    const plain = await pairing(app)
    expect(plain.kind === 'ready' && plain.url.startsWith(`https://${HOST}/pair?code=`)).toBe(true)
    await app.quit()
  })
})

describe('a paired device', () => {
  test('reads nothing without a token, with an unknown one, or once forgotten', async () => {
    const { app, base } = await start(forwarding)
    const project = await chat(app)
    const { token, device } = await pair(app, base)
    expect((await as(base, token)(`/chats/${project}`)).status).toBe(200)
    expect((await fetch(`${base}/chats/${project}`)).status).toBe(401)
    // A second client on the tailnet that never paired.
    expect((await as(base, 'a-token-never-given')(`/chats/${project}`)).status).toBe(401)
    // A request Tailscale marks as from Funnel, the public internet, is refused even with a token.
    const funnel = await fetch(`${base}/chats/${project}`, { headers: { authorization: `Bearer ${token}`, 'tailscale-funnel-request': '?1' } })
    expect(funnel.status).toBe(403)
    // Without a token, no path says whether it is a route, or whether it parses.
    for (const path of ['/no-such-route', `/chats/${project}/files/%E0%A4%A`]) expect([path, (await fetch(`${base}${path}`)).status]).toEqual([path, 401])
    expect((await as(base, token)('/chats')).status).toBe(200)
    const stream = eventStream(await as(base, token)('/events'))

    expect(await app.call('mobile.forget', { device: device.id })).toEqual([])
    // The stream it opened before ends, so it hears no chat after it was forgotten.
    await expect(stream.until(() => false, 5_000)).rejects.toThrow('the stream ended')
    expect((await as(base, token)(`/chats/${project}`)).status).toBe(401)
    expect((await as(base, token)('/computer')).status).toBe(401)
    await app.quit()
  })

  test('reaches no sign-in, setting, or window method, and hears only chat events', async () => {
    const { app, base, projects } = await start(forwarding)
    const project = await chat(app)
    writeFileSync(join(projects, project, 'part.stl'), 'solid part')
    const { token } = await pair(app, base)
    const call = as(base, token)
    const methods = Object.keys(handlers({} as Services))
    const probes = ['/auth/status', '/settings', '/setup', '/printer', '/keychain', ...methods.flatMap((m) => [`/${m}`, `/${m.replace('.', '/')}`])]
    for (const path of probes) {
      for (const method of ['GET', 'POST', 'PUT']) expect([path, method, (await call(path, method === 'GET' ? {} : { method, body: {} })).status]).toEqual([path, method, 404])
    }

    const stream = eventStream(await call('/events'))
    const MARKER = 'sk-marker-5d1f0c9e'
    await app.call('auth.setKey', { provider: 'anthropic', key: MARKER })
    const { rev } = (await (await call(`/chats/${project}/draft`, { method: 'PUT', body: { text: 'hello', pictures: [] } })).json()) as { rev: number }
    expect((await call(`/chats/${project}/send`, { method: 'POST', body: { rev } })).status).toBe(200)
    await stream.until((event) => (event.entries as ChatEntry[]).some((e) => e.kind === 'assistant' && e.text === 'answered by faux-a'))
    expect(stream.events.filter((event) => event.type !== 'chat' && event.type !== 'project')).toEqual([])
    void stream.close()

    const gets = ['/computer', '/models', '/chats', `/chats/${project}`, `/chats/${project}/files`, `/chats/${project}/files/part.stl`]
    for (const path of gets) {
      const answer = await call(path)
      expect([path, answer.status]).toEqual([path, 200])
      expect(await answer.text()).not.toContain(MARKER)
    }
    await app.quit()
  })

  test('pairs, reads, drafts with a picture, sends once, changes both roles, and reads a model file', async () => {
    const { app, base, projects } = await start(forwarding)
    const project = await chat(app)
    const { token, device, computer } = await pair(app, base)
    expect(device.name).toBe('iPhone')
    expect(await devices(app)).toEqual([device])
    // The window hears the new device, so Settings shows it and takes the spent code away.
    expect(await app.until((event) => event.type === 'paired')).toEqual({ type: 'paired', device, devices: [device] })
    const call = as(base, token)

    expect(await (await call('/computer')).json()).toEqual({ ...computer, version: '9.9.9', device })
    const listed = (await (await call('/chats')).json()) as MobileChat[]
    expect(listed.map(({ id, lead, helper }) => ({ id, lead, helper }))).toEqual([{ id: project, lead: { provider: 'faux', modelId: 'faux-a' }, helper: null }])
    expect(Array.isArray(await (await call('/models')).json())).toBe(true)

    const stream = eventStream(await call('/events'))
    const opened = (await (await call(`/chats/${project}`)).json()) as ChatView
    expect(opened.entries.map((e) => e.kind)).toEqual(['user', 'assistant'])

    const saved = await call(`/chats/${project}/draft`, { method: 'PUT', body: { text: 'From the phone', pictures: [{ name: 'shot.png', data: PNG }] } })
    const { rev } = (await saved.json()) as { rev: number }
    const send = () => call(`/chats/${project}/send`, { method: 'POST', body: { rev } })
    // Two sends of one revision at once, as a retry that overlaps a slow answer, both answer and send it once.
    const [sent, overlapping] = await Promise.all([send(), send()])
    expect([sent.status, overlapping.status]).toEqual([200, 200])
    expect(((await sent.json()) as { project: { id: string } }).project.id).toBe(project)
    const answered = await stream.until((event) => (event.entries as ChatEntry[]).some((e) => e.kind === 'assistant' && e.text === 'answered by faux-a'))
    expect(answered.project).toBe(project)
    await settled(app, project, 'answered by faux-a')

    // Sent again with the same revision, as after a lost answer, it sends nothing more.
    expect((await send()).status).toBe(200)
    const asked = ((await (await call(`/chats/${project}`)).json()) as ChatView).entries.flatMap((e) => (e.kind === 'user' ? [e] : []))
    expect(asked.map(({ text, images }) => ({ text, images }))).toEqual([
      { text: 'make the project', images: [] },
      { text: 'From the phone', images: [`refs/draft-${rev}/shot.png`] },
    ])

    const roles = await call(`/chats/${project}/roles`, { method: 'PUT', body: { lead: { provider: 'faux', modelId: 'faux-b' }, helper: { provider: 'faux', modelId: 'faux-a' } } })
    expect(await roles.json()).toEqual({ lead: { provider: 'faux', modelId: 'faux-b' }, helper: { provider: 'faux', modelId: 'faux-a' } })
    // The window and the phone's stream both hear the change, so neither shows a stale pair.
    const changed = (event: Record<string, unknown>) => event.type === 'project' && (event.project as { model: { modelId: string } }).model.modelId === 'faux-b'
    await app.until(changed)
    await stream.until(changed)
    const alone = await call(`/chats/${project}/roles`, { method: 'PUT', body: { helper: null } })
    expect(await alone.json()).toEqual({ lead: { provider: 'faux', modelId: 'faux-b' }, helper: null })
    expect((await call(`/chats/${project}/roles`, { method: 'PUT', body: { lead: { provider: 'faux', modelId: 'no-such' } } })).status).toBe(500)

    const folder = join(projects, project)
    mkdirSync(join(folder, 'print'), { recursive: true })
    writeFileSync(join(folder, 'part.STL'), 'solid part')
    writeFileSync(join(folder, 'print', 'plate.3mf'), 'PK3mf')
    writeFileSync(join(folder, 'notes.txt'), 'not a model')
    utimesSync(join(folder, 'part.STL'), 1_000, 1_000)
    const files = (await (await call(`/chats/${project}/files`)).json()) as ModelFile[]
    expect(files.map((file) => file.rel)).toEqual(['print/plate.3mf', 'part.STL'])
    expect(files[1]).toEqual({ rel: 'part.STL', size: 'solid part'.length, modifiedMs: 1_000_000 })
    const read = await call(`/chats/${project}/files/print/plate.3mf`)
    expect([read.status, read.headers.get('content-type'), await read.text()]).toEqual([200, 'model/3mf', 'PK3mf'])
    expect(read.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call(`/chats/${project}/files/part.STL`)).headers.get('content-type')).toBe('model/stl')
    expect((await call('/chats/no-such-project')).status).toBe(404)
    expect((await call(`/chats/${project}/send`, { method: 'POST', body: { rev: 'one' } })).status).toBe(400)
    void stream.close()
    await app.quit()
  }, 60_000)

  test("drafts and sends apart from the computer's own unsent message, which state.get alone shows", async () => {
    const { app, base } = await start(forwarding)
    const project = await chat(app)
    const { token } = await pair(app, base)
    const call = as(base, token)
    const { rev: desk } = (await app.call('drafts.set', { key: project, text: 'Typed on the computer', attachments: [] })) as { rev: number }

    // A picture whose name is as long as a file name may be still goes out.
    const long = `${'p'.repeat(220)}.png`
    const { rev } = (await (await call(`/chats/${project}/draft`, { method: 'PUT', body: { text: 'From the phone', pictures: [{ name: long, data: PNG }] } })).json()) as { rev: number }
    const shown = async () => ((await app.call('state.get')) as StoredState).drafts
    expect(await shown()).toEqual({ [project]: { text: 'Typed on the computer', attachments: [], rev: desk } })
    expect((await call(`/chats/${project}/send`, { method: 'POST', body: { rev } })).status).toBe(200)
    await settled(app, project, 'answered by faux-a')
    expect(await shown()).toEqual({ [project]: { text: 'Typed on the computer', attachments: [], rev: desk } })
    const sent = ((await (await call(`/chats/${project}`)).json()) as ChatView).entries.flatMap((e) => (e.kind === 'user' ? e.images : []))
    expect(sent).toEqual([`refs/draft-${rev}/${long}`])
    await app.quit()
  }, 60_000)

  /** Holds the update gate's answer once `stall.held` is set, so a send waits after it read its draft. */
  const stalling = () => {
    const stall: { held: boolean; release?: () => void } = { held: false }
    const hold: NonNullable<NonNullable<Parameters<typeof spawnSidecar>[3]>['hold']> = (request, answer) => {
      if (request.method !== 'busy' || !stall.held || stall.release !== undefined) return answer()
      stall.release = answer
    }
    const stalled = async () => {
      while (stall.release === undefined) await Bun.sleep(10)
      return stall.release
    }
    return { stall, hold, stalled }
  }

  /** The phone's calls for one chat, as a paired device. */
  const phone = (base: string, token: string, project: string) => {
    const call = as(base, token)
    return {
      call,
      draft: async (text: string, pictures: { name: string; data: string }[] = []) =>
        ((await (await call(`/chats/${project}/draft`, { method: 'PUT', body: { text, pictures } })).json()) as { rev: number }).rev,
      send: (rev: number) => call(`/chats/${project}/send`, { method: 'POST', body: { rev } }),
      settle: async (rev: number) => (await (await call(`/chats/${project}/sends/${rev}/settle`, { method: 'POST' })).json()) as { accepted: boolean },
      asked: async () => ((await (await call(`/chats/${project}`)).json()) as ChatView).entries.flatMap((e) => (e.kind === 'user' ? [e.text] : [])),
    }
  }

  test('settles a send whose answer was lost as accepted once the chat holds it, and a replay starts no second job', async () => {
    const { app, base } = await start(forwarding)
    const project = await chat(app)
    const { token } = await pair(app, base)
    const device = phone(base, token, project)

    const rev = await device.draft('From the phone')
    // The answer is dropped before the device reads it, as when the link goes down mid-send.
    const lost = new AbortController()
    await fetch(`${base}/chats/${project}/send`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ rev }), signal: lost.signal })
    lost.abort()
    expect(await device.settle(rev)).toEqual({ accepted: true })
    expect(await device.settle(rev)).toEqual({ accepted: true })
    expect((await device.send(rev)).status).toBe(200)
    await settled(app, project, 'answered by faux-a')

    expect(await device.asked()).toEqual(['make the project', 'From the phone'])
    expect((await device.call(`/chats/${project}/sends/one/settle`, { method: 'POST' })).status).toBe(400)
    await app.quit()
  }, 60_000)

  test('settles a send the chat does not hold as refused for good, so a late post of it starts no job', async () => {
    const { app, base } = await start(forwarding)
    const project = await chat(app)
    const { token } = await pair(app, base)
    const device = phone(base, token, project)

    const rev = await device.draft('From the phone')
    expect(await device.settle(rev)).toEqual({ accepted: false })
    const late = await device.send(rev)
    expect([late.status, await late.json()]).toEqual([409, { error: 'The draft changed before it went out. Send it again.' }])
    expect(await device.settle(rev)).toEqual({ accepted: false })
    expect(await device.asked()).toEqual(['make the project'])
    expect(((await app.call('chat.open', { project })) as ChatView).running).toBe(false)
    await app.quit()
  }, 60_000)

  test('settles a stalled send as refused, so only the message sent after it starts a job and keeps its picture', async () => {
    const { stall, hold, stalled } = stalling()
    const { app, base, projects } = await start(forwarding, {}, { hold })
    const project = await chat(app)
    const { token } = await pair(app, base)
    const device = phone(base, token, project)
    const picture = [{ name: 'clip.png', data: PNG }]

    const first = await device.draft('Make it 2 mm thicker', picture)
    stall.held = true
    const sending = device.send(first)
    const release = await stalled()
    expect(await device.settle(first)).toEqual({ accepted: false })
    release()
    expect((await sending).status).toBe(409)

    const second = await device.draft('Make it 2 mm thicker', picture)
    expect((await device.send(second)).status).toBe(200)
    await settled(app, project, 'answered by faux-a')
    expect(await device.asked()).toEqual(['make the project', 'Make it 2 mm thicker'])
    const refs = join(projects, project, 'refs')
    expect(existsSync(join(refs, `draft-${first}`))).toBe(false)
    expect(existsSync(join(refs, `draft-${second}`, 'clip.png'))).toBe(true)
    await app.quit()
  }, 60_000)

  test('refuses a send that stalled past an edit, so only the edited message starts a job, and keeps no copy of its picture', async () => {
    const { stall, hold, stalled } = stalling()
    const { app, base, projects } = await start(forwarding, {}, { hold })
    const project = await chat(app)
    const { token } = await pair(app, base)
    const device = phone(base, token, project)

    const first = await device.draft('Make it 2 mm thicker', [{ name: 'clip.png', data: PNG }])
    stall.held = true
    const sending = device.send(first)
    const release = await stalled()
    const edited = await device.draft('Make it 3 mm thicker')
    release()

    const refused = await sending
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'The draft changed before it went out. Send it again.' }])
    expect((await device.send(edited)).status).toBe(200)
    await settled(app, project, 'answered by faux-a')
    expect(await device.asked()).toEqual(['make the project', 'Make it 3 mm thicker'])
    expect(existsSync(join(projects, project, 'refs', `draft-${first}`))).toBe(false)
    await app.quit()
  }, 60_000)

  test('answers a replay that overlaps the first send with the chat, and starts one job', async () => {
    const { stall, hold, stalled } = stalling()
    const { app, base } = await start(forwarding, {}, { hold })
    const project = await chat(app)
    const { token } = await pair(app, base)
    const device = phone(base, token, project)

    const rev = await device.draft('From the phone')
    stall.held = true
    const sending = device.send(rev)
    const release = await stalled()
    // The replay reads the draft before the first send commits, then waits behind it for the update gate.
    const replaying = device.send(rev)
    await Bun.sleep(100)
    release()
    const [first, replay] = await Promise.all([sending, replaying])
    expect([first.status, replay.status]).toEqual([200, 200])
    expect(await first.json()).toMatchObject({ project: { id: project } })
    await settled(app, project, 'answered by faux-a')
    expect(await device.asked()).toEqual(['make the project', 'From the phone'])
    await app.quit()
  }, 60_000)

  test('refuses a send while the agent works, and a send to a retired lead, with the words the device shows', async () => {
    const { app, base, projects } = await start(forwarding, { M3D_RETIRED: 'faux-b' })
    const project = await chat(app)
    const { token } = await pair(app, base)
    const device = phone(base, token, project)

    expect((await device.send(await device.draft('please wait'))).status).toBe(200)
    while (!existsSync(join(projects, project, 'started'))) await Bun.sleep(20)
    const refused = await device.draft('make it red', [{ name: 'red.png', data: PNG }])
    const busy = await device.send(refused)
    expect([busy.status, await busy.json()]).toEqual([423, { error: 'The agent is still working on the last message.' }])
    // The refusal retired its revision, so the picture copied for it leaves the project.
    expect(existsSync(join(projects, project, 'refs', `draft-${refused}`))).toBe(false)
    writeFileSync(join(projects, project, 'go'), '')
    await settled(app, project, 'answered by faux-a')
    // The refusal retired its revision, so a replay that arrives once the agent is idle sends nothing.
    expect((await device.send(refused)).status).toBe(409)

    await app.call('projects.setLead', { project, model: { provider: 'faux', modelId: 'faux-b' } })
    expect((await device.send(await device.draft('and now?'))).status).toBe(200)
    await app.until((event) => event.type === 'chat' && event.project === project && (event.waiting as { retired?: unknown } | null)?.retired !== undefined, 30_000)
    const retired = await device.send(await device.draft('once more'))
    expect(retired.status).toBe(422)
    expect(((await retired.json()) as { error: string }).error).toContain('was retired')
    expect(await device.asked()).toEqual(['make the project', 'please wait', 'and now?'])
    await app.quit()
  }, 60_000)

  test('a refused send removes only the copies it made, and leaves the files it found in the project', async () => {
    const { app, base, projects } = await start(forwarding)
    const project = await chat(app)
    const { token } = await pair(app, base)
    const device = phone(base, token, project)
    expect((await device.send(await device.draft('please wait'))).status).toBe(200)
    while (!existsSync(join(projects, project, 'started'))) await Bun.sleep(20)
    const refs = join(projects, project, 'refs')
    const found = (rev: number, name: string) => {
      mkdirSync(join(refs, `draft-${rev}`), { recursive: true })
      writeFileSync(join(refs, `draft-${rev}`, name), 'made by the person')
    }

    // A text-only send copies nothing, so its refusal removes nothing.
    const text = await device.draft('make it red')
    found(text, 'keep.txt')
    expect((await device.send(text)).status).toBe(423)
    expect(existsSync(join(refs, `draft-${text}`, 'keep.txt'))).toBe(true)

    const photo = await device.draft('make it blue', [{ name: 'blue.png', data: PNG }])
    found(photo, 'beside.txt')
    expect((await device.send(photo)).status).toBe(423)
    expect(existsSync(join(refs, `draft-${photo}`, 'blue.png'))).toBe(false)
    expect(existsSync(join(refs, `draft-${photo}`, 'beside.txt'))).toBe(true)

    writeFileSync(join(projects, project, 'go'), '')
    await settled(app, project, 'answered by faux-a')
    await app.quit()
  }, 60_000)

  test('reads no file outside the chat, through a link, in the app records, or that is not a model', async () => {
    const { app, base, dir, projects } = await start(forwarding)
    const project = await chat(app)
    const { token } = await pair(app, base)
    const call = as(base, token)
    const folder = join(projects, project)
    writeFileSync(join(projects, 'escape.stl'), 'outside the chat')
    writeFileSync(join(dir, 'outside.stl'), 'outside the projects')
    symlinkSync(join(dir, 'outside.stl'), join(folder, 'linked.stl'))
    writeFileSync(join(folder, '.m3d', 'hidden.stl'), 'the app records')
    writeFileSync(join(folder, 'notes.txt'), 'not a model')
    writeFileSync(join(folder, 'part.stl'), 'solid part')
    // Links that stay in the chat but name a model: one to the app records, one to a file that is not a model.
    symlinkSync(join(folder, '.m3d', 'hidden.stl'), join(folder, 'records.stl'))
    symlinkSync(join(folder, 'notes.txt'), join(folder, 'notes.glb'))

    expect(((await (await call(`/chats/${project}/files`)).json()) as ModelFile[]).map((f) => f.rel)).toEqual(['part.stl'])
    for (const rel of ['..%2Fescape.stl', '%2E%2E/escape.stl', 'linked.stl', 'records.stl', 'notes.glb', '.m3d/hidden.stl', '.m3d%2Fhidden.stl', 'notes.txt', 'missing.stl']) {
      const answer = await call(`/chats/${project}/files/${rel}`)
      expect([rel, answer.status]).toEqual([rel, 404])
    }
    expect((await call(`/chats/${project}/files/part.stl`)).status).toBe(200)

    // A chat folder that became a link reads nothing, listed or by name.
    renameSync(folder, join(dir, 'moved'))
    symlinkSync(join(dir, 'moved'), folder)
    expect((await call(`/chats/${project}/files`)).status).toBe(404)
    expect((await call(`/chats/${project}/files/part.stl`)).status).toBe(404)
    await app.quit()
  })

  test('changes neither role when one of them is refused', async () => {
    const { app, base } = await start(forwarding)
    const project = await chat(app)
    const { token } = await pair(app, base)
    const call = as(base, token)

    const refused = await call(`/chats/${project}/roles`, { method: 'PUT', body: { lead: { provider: 'faux', modelId: 'faux-b' }, helper: { provider: 'faux', modelId: 'no-such' } } })
    expect(refused.status).toBe(500)
    const listed = ((await (await call('/chats')).json()) as MobileChat[]).find((row) => row.id === project)
    expect([listed?.lead, listed?.helper]).toEqual([{ provider: 'faux', modelId: 'faux-a' }, null])
    await app.quit()
  }, 60_000)
})
