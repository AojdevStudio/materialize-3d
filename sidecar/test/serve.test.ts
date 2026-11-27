import { describe, expect, test } from 'bun:test'
import { readServe } from '../src/serve'

const PORT = 47380
const HOST = 'computer.tail0000.ts.net'
const KEY = `${HOST}:${PORT}`
const SETUP = `tailscale serve --bg --https=${PORT} http://127.0.0.1:${PORT}`
/** Another service Tailscale Serve already forwards, which the phone service must pass over. */
const OTHER = { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } }
const root = (proxy = `http://127.0.0.1:${PORT}`) => ({ Handlers: { '/': { Proxy: proxy } } })
/** Serve forwarding `served` to the phone service, beside the other service on 443. */
const forwarding = (served = KEY) => ({
  TCP: { 443: { HTTPS: true }, [served.slice(served.lastIndexOf(':') + 1)]: { HTTPS: true } },
  Web: { ...OTHER, [served]: root() },
})
/** `forwarding`, with the phone service's address also sending `/api/` to another service. */
const shared = () => {
  const served = forwarding()
  return { ...served, Web: { ...served.Web, [KEY]: { Handlers: { ...root().Handlers, '/api/': { Proxy: 'http://127.0.0.1:9' } } } } }
}
const read = (status: object, tailscale = 'tailscale') => readServe(JSON.stringify(status), PORT, tailscale)

describe('readServe', () => {
  test('answers the address Serve forwards to the service, with no port when Serve uses 443', () => {
    expect(read(forwarding())).toEqual({ kind: 'served', origin: KEY })
    expect(read(forwarding(`${HOST}:443`))).toEqual({ kind: 'served', origin: HOST })
    expect(read({ TCP: { [PORT]: { HTTPS: true } }, Web: { [KEY]: root(`http://localhost:${PORT}`) } })).toEqual({ kind: 'served', origin: KEY })
  })

  test('answers the setup command while Serve forwards nothing to the service over HTTPS', () => {
    expect(readServe('', PORT, 'tailscale')).toEqual({ kind: 'setup', command: SETUP })
    expect(read({})).toEqual({ kind: 'setup', command: SETUP })
    expect(read({ Web: OTHER })).toEqual({ kind: 'setup', command: SETUP })
    // A plain HTTP listener cannot answer the https address a QR would name.
    expect(read({ TCP: { [PORT]: { HTTP: true } }, Web: forwarding().Web })).toEqual({ kind: 'setup', command: SETUP })
  })

  test('names the Mac app the way the command is shown', () => {
    const mac = "'/Applications/Tailscale.app/Contents/MacOS/Tailscale'"
    expect(read({}, mac)).toEqual({ kind: 'setup', command: `${mac} serve --bg --https=${PORT} http://127.0.0.1:${PORT}` })
  })

  test('gives an address shared with other paths a free HTTPS port of its own', () => {
    // Tailscale prefers a longer mount, so `/api/` could take the code or a token. Setting `/` again cannot help.
    expect(read(shared())).toEqual({
      kind: 'setup',
      reason: `Serve on ${KEY} also sends other paths to other services, so a phone could reach the wrong one. Give this app an HTTPS port of its own.`,
      command: `tailscale serve --bg --https=${PORT + 1} http://127.0.0.1:${PORT}`,
    })
    // A port a terminal's own `tailscale serve` holds is taken too.
    expect(read({ ...shared(), Foreground: { session: { TCP: { [PORT + 1]: { HTTPS: true } } } } })).toMatchObject({
      kind: 'setup',
      command: `tailscale serve --bg --https=${PORT + 2} http://127.0.0.1:${PORT}`,
    })
  })

  test('says so, and names no port, when every port near the service is taken', () => {
    const first = Object.fromEntries(Array.from({ length: 99 }, (_, n) => [PORT + n, { HTTPS: true }]))
    expect(read({ ...shared(), TCP: { ...shared().TCP, ...first } })).toMatchObject({ kind: 'setup', command: `tailscale serve --bg --https=${PORT + 99} http://127.0.0.1:${PORT}` })
    const every = { ...first, [PORT + 99]: { HTTPS: true } }
    expect(read({ ...shared(), TCP: { ...shared().TCP, ...every } })).toEqual({
      kind: 'off',
      detail: `Serve on ${KEY} also sends other paths to other services, and every port from ${PORT} to ${PORT + 99} is taken. Free an HTTPS port in Tailscale, then check again.`,
    })
  })

  test('refuses an address Funnel makes public, unless a private one also forwards to the service', () => {
    expect(read({ ...forwarding(), AllowFunnel: { [KEY]: true } })).toEqual({
      kind: 'off',
      detail: `Tailscale Funnel makes ${KEY} public on the internet. Turn Funnel off for it with tailscale funnel --https=${PORT} off, then check again.`,
    })
    // A private address wins over a public one listed before it.
    const open = `${HOST}:443`
    expect(read({ TCP: { 443: { HTTPS: true }, [PORT]: { HTTPS: true } }, AllowFunnel: { [open]: true }, Web: { [open]: root(), [KEY]: root() } })).toEqual({
      kind: 'served',
      origin: KEY,
    })
  })

  test('throws on output that is not a Serve status', () => {
    expect(() => readServe('{"Web": []}', PORT, 'tailscale')).toThrow('tailscale serve status --json printed what this app cannot read')
    expect(() => readServe('not json', PORT, 'tailscale')).toThrow()
  })
})
