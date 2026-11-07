import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { compile, obj } from '@earendil-works/pi-schema'
import { Host } from '../src/host'

/** The sidecar as Rust runs it: a child process spoken to over stdin and stdout. */
function spawnSidecar() {
  const child = Bun.spawn(['bun', 'src/main.ts', '--app-version', '9.9.9'], {
    cwd: `${import.meta.dir}/..`,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const lines = (async function* () {
    let buffered = ''
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buffered += chunk
      let end = buffered.indexOf('\n')
      while (end >= 0) {
        yield JSON.parse(buffered.slice(0, end)) as Record<string, unknown>
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf('\n')
      }
    }
  })()
  const next = async () => (await lines.next()).value
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  return { child, next, send }
}

describe('the pipe to Rust', () => {
  test('the sidecar says it is ready, answers a call, and refuses an unknown method', async () => {
    const { child, next, send } = spawnSidecar()
    expect(await next()).toEqual({ kind: 'event', event: { type: 'ready', version: '9.9.9' } })
    send({ kind: 'call', id: 1, method: 'app.ping', params: {} })
    expect(await next()).toEqual({ kind: 'reply', id: 1, ok: true, value: { version: '9.9.9' } })
    send({ kind: 'call', id: 2, method: 'app.nope', params: {} })
    expect(await next()).toEqual({ kind: 'reply', id: 2, ok: false, error: 'no method app.nope' })
    child.stdin.end()
    expect(await child.exited).toBe(0)
  })

  test('a line that is not a protocol message ends the sidecar with a failure', async () => {
    const { child, next, send } = spawnSidecar()
    await next()
    send({ kind: 'mystery' })
    expect(await child.exited).not.toBe(0)
  })

  test('a request to Rust resolves with its answer, and an open request fails when the pipe closes', async () => {
    const input = new PassThrough()
    const written: string[] = []
    const host = new Host((line) => written.push(line))
    const serving = host.serve({ 'app.ping': { params: compile(obj({})), run: async () => ({ version: 'x' }) } }, input)

    const secret = host.request('keychain.get', { account: 'anthropic' })
    expect(JSON.parse(written[0]!)).toEqual({ kind: 'request', id: 1, method: 'keychain.get', params: { account: 'anthropic' } })
    input.write(`${JSON.stringify({ kind: 'answer', id: 1, ok: true, value: { secret: null } })}\n`)
    expect(await secret).toEqual({ secret: null })

    const refused = host.request('keychain.set', { account: 'anthropic', secret: 's' })
    input.write(`${JSON.stringify({ kind: 'answer', id: 2, ok: false, error: 'Keychain is locked' })}\n`)
    await expect(refused).rejects.toThrow('Keychain is locked')

    const open = host.request('slice', { project: 'p', inputs: ['a.stl'], output: 'print/a.3mf' })
    input.end()
    await serving
    await expect(open).rejects.toThrow('the app closed the pipe')
  })
})
