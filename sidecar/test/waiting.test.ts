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
