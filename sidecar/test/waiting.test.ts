import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, ChatView } from '../src/protocol'
import { spawnSidecar } from './sidecar'

/**
 * A proxy that speaks Anthropic's Messages API, as Ossie's Mac reaches Anthropic, and remembers who called. A request
 * with a token in `refuse` waits for `release`, then is refused as a bad login.
 */
function anthropicProxy(reply: string, refuse: { token: string; release: Promise<void> } | undefined = undefined) {
  const seen: { authorization: string | null; path: string }[] = []
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const authorization = request.headers.get('authorization')
      seen.push({ authorization, path: new URL(request.url).pathname })
      if (refuse !== undefined && authorization === `Bearer ${refuse.token}`) {
        await refuse.release
        return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })
      }
      const body =
        event('message_start', {
          type: 'message_start',
          message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
        }) +
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }) +
        event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }) +
        event('message_stop', { type: 'message_stop' })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

describe('a turn whose provider is not signed in', () => {
  test('waits with the fix named, through a restart, and goes on once the person signs in', async () => {
    const proxy = anthropicProxy('Hello from the proxy')
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    const keychain = new Map<string, string>()
    const first = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), keychain)
    await first.next()
    const { id: project } = (await first.call('projects.create', { title: 'A cube' })) as { id: string }
    await first.call('chat.open', { project })
    await first.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    const waiting = await first.until((event) => event.type === 'chat' && event.waiting !== null)
    expect(waiting.waiting).toEqual({
      kind: 'login',
      provider: 'anthropic',
      name: 'Anthropic',
      fix: 'Sign in to Anthropic. The message picks up where it stopped.',
    })
    await first.quit()

    const second = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), keychain)
    await second.next()
    const reopened = (await second.call('chat.open', { project })) as ChatView
    expect(reopened.waiting?.kind).toBe('login')
    expect(reopened.entries).toEqual([{ id: expect.any(Number), kind: 'user', text: 'A 20 mm cube', images: [] }])

    await second.call('auth.setKey', { provider: 'anthropic', key: 'proxy-token', baseUrl: proxy.url })
    const answered = await second.until(
      (event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant'),
    )
    expect((answered.entries as ChatEntry[]).find((entry) => entry.kind === 'assistant')).toMatchObject({ text: 'Hello from the proxy' })
    expect(answered.waiting).toBeNull()
    expect(proxy.seen).toEqual([{ authorization: 'Bearer proxy-token', path: '/v1/messages' }])

    const view = (await second.call('chat.open', { project })) as ChatView
    expect(view.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant'])
    await second.quit()
    proxy.stop()
  })

  test('a request refused after a newer login was saved goes on with that login, without waiting', async () => {
    const release = Promise.withResolvers<void>()
    const proxy = anthropicProxy('Hello with the new key', { token: 'old-token', release: release.promise })
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), new Map())
    await app.next()
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.open', { project })
    await app.call('auth.setKey', { provider: 'anthropic', key: 'old-token', baseUrl: proxy.url })
    await app.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    while (proxy.seen.length === 0) await Bun.sleep(10)
    await app.call('auth.setKey', { provider: 'anthropic', key: 'new-token', baseUrl: proxy.url })
    await Bun.sleep(200)
    release.resolve()
    const answered = await app.until(
      (event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant'),
      10_000,
    )
    expect((answered.entries as ChatEntry[]).find((entry) => entry.kind === 'assistant')).toMatchObject({ text: 'Hello with the new key' })
    expect(proxy.seen.map((call) => call.authorization)).toEqual(['Bearer old-token', 'Bearer new-token'])
    await app.quit()
    proxy.stop()
  }, 20_000)

  test('a turn refused after a newer login was saved goes on with it only with the update pass, and once a failed install opens the gate', async () => {
    const release = Promise.withResolvers<void>()
    const proxy = anthropicProxy('Hello after the update', { token: 'old-token', release: release.promise })
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), new Map())
    await app.next()
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.open', { project })
    await app.call('auth.setKey', { provider: 'anthropic', key: 'old-token', baseUrl: proxy.url })
    await app.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    while (proxy.seen.length === 0) await Bun.sleep(10)
    await app.call('auth.setKey', { provider: 'anthropic', key: 'new-token', baseUrl: proxy.url })
    // An update starts installing while the old request is still out.
    app.gate.installing = true
    release.resolve()
    const waiting = await app.until((event) => event.type === 'chat' && event.waiting !== null)
    expect(waiting.waiting).toMatchObject({ kind: 'login', provider: 'anthropic' })
    await Bun.sleep(500)
    expect(proxy.seen).toHaveLength(1)
    // The install fails and the gate opens: the turn goes on by itself, with no new sign-in.
    app.gate.installing = false
    const answered = await app.until(
      (event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant'),
      10_000,
    )
    expect((answered.entries as ChatEntry[]).find((entry) => entry.kind === 'assistant')).toMatchObject({ text: 'Hello after the update' })
    expect(proxy.seen.map((call) => call.authorization)).toEqual(['Bearer old-token', 'Bearer new-token'])
    await app.quit()
    proxy.stop()
  }, 30_000)

  test('a sign-in that waits out an installing update holds up neither the start nor a quit, and goes on later', async () => {
    const proxy = anthropicProxy('Hello after the install', { token: 'old-token', release: Promise.resolve() })
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    const keychain = new Map<string, string>()
    const start = () => spawnSidecar(join(dir, 'state'), join(dir, 'projects'), keychain)
    const first = start()
    await first.next()
    const { id: project } = (await first.call('projects.create', { title: 'A cube' })) as { id: string }
    await first.call('chat.open', { project })
    await first.call('auth.setKey', { provider: 'anthropic', key: 'old-token', baseUrl: proxy.url })
    await first.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    await first.until((event) => event.type === 'chat' && event.waiting !== null)
    // A new login is saved while an update installs, so the turn waits for the pass.
    first.gate.installing = true
    await first.call('auth.setKey', { provider: 'anthropic', key: 'new-token', baseUrl: proxy.url })
    await first.quit()
    // The app starts again with the update still installing, and quits at once.
    const second = start()
    second.gate.installing = true
    await second.next()
    await second.call('chat.open', { project })
    const quit = Date.now()
    await second.quit()
    expect(Date.now() - quit).toBeLessThan(3000)
    expect(proxy.seen).toHaveLength(1)
    // With the gate open, the turn goes on with the new login, with no new sign-in.
    const third = start()
    await third.next()
    await third.until(
      (event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant'),
      10_000,
    )
    expect(proxy.seen.map((call) => call.authorization)).toEqual(['Bearer old-token', 'Bearer new-token'])
    await third.quit()
    proxy.stop()
  }, 40_000)

  test('a turn that failed with no login goes on when one is saved while the failure is read', async () => {
    const proxy = anthropicProxy('Hello after the slow read')
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    // While `holding`, each Keychain read waits in `held` until the test answers it.
    let holding = true
    const held: (() => void)[] = []
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), new Map(), {
      hold: (request, answer) => (holding && request.method === 'keychain.get' ? held.push(answer) : answer()),
    })
    await app.next()
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.open', { project })
    const nextRead = async (count: number) => {
      while (held.length < count) await Bun.sleep(10)
    }
    // The turn's request finds no login and fails. Its failure is read, and that read asks the Keychain again.
    await app.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    await nextRead(1)
    held[0]?.()
    await nextRead(2)
    // A key is saved, and its sign-in looks for waits, while the failure's read still waits on the Keychain.
    holding = false
    await app.call('auth.setKey', { provider: 'anthropic', key: 'new-token', baseUrl: proxy.url })
    await Bun.sleep(200)
    for (const answer of held.slice(1)) answer()
    const answered = await app.until(
      (event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant'),
      10_000,
    )
    expect((answered.entries as ChatEntry[]).find((entry) => entry.kind === 'assistant')).toMatchObject({ text: 'Hello after the slow read' })
    await app.quit()
    proxy.stop()
  }, 20_000)

  test('a stopped turn that waited on a sign-in stays stopped when the person signs in', async () => {
    const proxy = anthropicProxy('never')
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), new Map())
    await app.next()
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.open', { project })
    await app.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    await app.until((event) => event.type === 'chat' && event.waiting !== null)
    await app.call('chat.stop', { project })
    await app.call('auth.setKey', { provider: 'anthropic', key: 'new-token', baseUrl: proxy.url })
    await Bun.sleep(500)
    expect(proxy.seen).toHaveLength(0)
    expect(((await app.call('chat.open', { project })) as ChatView).waiting).toBeNull()
    await app.quit()
    proxy.stop()
  }, 20_000)

  test('a restart does not try a refused login again, only one saved after it', async () => {
    const proxy = anthropicProxy('Hello after the restart', { token: 'old-token', release: Promise.resolve() })
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    const keychain = new Map<string, string>()
    const first = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), keychain)
    await first.next()
    const { id: project } = (await first.call('projects.create', { title: 'A cube' })) as { id: string }
    await first.call('chat.open', { project })
    await first.call('auth.setKey', { provider: 'anthropic', key: 'old-token', baseUrl: proxy.url })
    await first.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    await first.until((event) => event.type === 'chat' && event.waiting !== null)
    await first.quit()
    const second = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), keychain)
    await second.next()
    await Bun.sleep(500)
    expect(proxy.seen).toHaveLength(1)
    await second.call('chat.open', { project })
    await second.call('auth.setKey', { provider: 'anthropic', key: 'new-token', baseUrl: proxy.url })
    await second.until(
      (event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant'),
      10_000,
    )
    expect(proxy.seen.map((call) => call.authorization)).toEqual(['Bearer old-token', 'Bearer new-token'])
    await second.quit()
    proxy.stop()
  }, 30_000)

  test('a refused login with no newer one saved waits for a sign-in, and is not tried again', async () => {
    const proxy = anthropicProxy('never', { token: 'old-token', release: Promise.resolve() })
    const dir = mkdtempSync(join(tmpdir(), 'm3d-wait-'))
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), new Map())
    await app.next()
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.open', { project })
    await app.call('auth.setKey', { provider: 'anthropic', key: 'old-token', baseUrl: proxy.url })
    await app.call('chat.send', { project, requestId: 'r1', text: 'A 20 mm cube', attachments: [] })
    const waiting = await app.until((event) => event.type === 'chat' && event.waiting !== null)
    expect(waiting.waiting).toMatchObject({ kind: 'login', provider: 'anthropic' })
    await Bun.sleep(500)
    expect(proxy.seen).toHaveLength(1)
    await app.quit()
    proxy.stop()
  }, 20_000)
})
