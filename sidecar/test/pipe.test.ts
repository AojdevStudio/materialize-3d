import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { compile, obj } from '@earendil-works/pi-schema'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../src/host'
import { spawnSidecar as spawnIn } from './sidecar'

function spawnSidecar() {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-pipe-'))
  return spawnIn(join(dir, 'state'), join(dir, 'projects'))
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

  test('a call the sidecar accepted finishes and replies before the closed pipe ends it', async () => {
    const input = new PassThrough()
    const written: string[] = []
    const host = new Host((line) => written.push(line))
    const slow = { params: compile(obj({})), run: async () => Bun.sleep(50).then(() => ({ version: 'late' })) }
    const serving = host.serve({ 'app.ping': slow }, input)
    input.end(`${JSON.stringify({ kind: 'call', id: 1, method: 'app.ping', params: {} })}\n`)
    await serving
    expect(written.map((line) => JSON.parse(line))).toEqual([{ kind: 'reply', id: 1, ok: true, value: { version: 'late' } }])
  })

  test('a call that asks Rust for something after the pipe closed fails instead of waiting forever', async () => {
    const input = new PassThrough()
    const written: string[] = []
    const host = new Host((line) => written.push(line))
    const asksLate = {
      params: compile(obj({})),
      run: async () => {
        await Bun.sleep(20)
        await host.request('keychain.get', { account: 'anthropic' })
        return { version: 'unreachable' }
      },
    }
    const serving = host.serve({ 'app.ping': asksLate }, input)
    input.end(`${JSON.stringify({ kind: 'call', id: 1, method: 'app.ping', params: {} })}\n`)
    await serving
    expect(written.map((line) => JSON.parse(line))).toEqual([{ kind: 'reply', id: 1, ok: false, error: 'the app closed the pipe' }])
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

    const open = host.request('slice', { operation: 'op', project: 'p', inputs: ['a.stl'], output: 'print/a.3mf' })
    input.end()
    await serving
    await expect(open).rejects.toThrow('the app closed the pipe')
  })
})
