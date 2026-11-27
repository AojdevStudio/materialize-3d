/**
 * Where Tailscale Serve gives the phone service an HTTPS address, read from what `tailscale serve status --json` printed.
 * `docs/adr/0001-mobile-service-over-tailscale-serve.md` sets the rules: an address must take HTTPS, send every path to
 * the service, and not be public through Funnel.
 */
import { bool, compile, map, obj, opt, str } from '@earendil-works/pi-schema'
import type { MobilePairing } from './protocol'

/**
 * What `tailscale serve status --json` says, as far as this app reads it: which ports take HTTPS, where each path of
 * each served address goes, and which addresses Funnel makes public.
 */
const serveStatus = compile(
  obj(
    {
      TCP: opt(map(obj({ HTTPS: opt(bool()) }, { open: true }))),
      Web: opt(map(obj({ Handlers: opt(map(obj({ Proxy: opt(str()) }, { open: true }))) }, { open: true }))),
      AllowFunnel: opt(map(bool())),
      /** What each `tailscale serve` still running in a terminal serves, by its session. */
      Foreground: opt(map(obj({ TCP: opt(map(obj({}, { open: true }))) }, { open: true }))),
    },
    { open: true },
  ),
)

/**
 * The origin a QR can name, such as `host.tailnet.ts.net:47380`, with no port when Serve uses 443. Otherwise the command
 * that sets Serve up, or why no phone can reach the service.
 */
export type Served = { kind: 'served'; origin: string } | Exclude<MobilePairing, { kind: 'ready' }>

/**
 * Reads `out`, what `tailscale serve status --json` printed, for the phone service on loopback `port`. `tailscale` is
 * how a command shown to the person names the command line. Throws when `out` is not a Serve status this app can read.
 */
export function readServe(out: string, port: number, tailscale: string): Served {
  const status: unknown = out.trim() === '' ? {} : JSON.parse(out)
  if (!serveStatus.check(status)) throw new Error(`tailscale serve status --json printed what this app cannot read: ${out.slice(0, 200)}`)
  const forwards = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  const portOf = (served: string) => served.slice(served.lastIndexOf(':') + 1)
  // An address the QR can name takes HTTPS, and sends every path to this service, so no other mount Tailscale prefers
  // takes the pairing code or a device's token. A plain HTTP listener, or one shared with other paths, is passed over.
  const https = Object.entries(status.Web ?? {}).filter(([at, web]) => status.TCP?.[portOf(at)]?.HTTPS === true && forwards.includes(web.Handlers?.['/']?.Proxy ?? ''))
  const ours = https.flatMap(([at, web]) => (Object.keys(web.Handlers ?? {}).length === 1 ? [at] : []))
  // A private address wins over a public one, in whatever order Serve lists them.
  const served = ours.find((at) => status.AllowFunnel?.[at] !== true)
  if (served !== undefined) return { kind: 'served', origin: served.replace(/:443$/, '') }
  const [open] = ours
  if (open !== undefined) {
    return { kind: 'off', detail: `Tailscale Funnel makes ${open} public on the internet. Turn Funnel off for it with ${tailscale} funnel --https=${portOf(open)} off, then check again.` }
  }
  // An address that sends other paths elsewhere too cannot be fixed by setting its `/` again, since Serve changes only the
  // mount it is given. The phone service gets an HTTPS port of its own instead.
  const [shared] = https
  if (shared === undefined) return { kind: 'setup', command: `${tailscale} serve --bg --https=${port} http://127.0.0.1:${port}` }
  // A port a terminal's `tailscale serve` holds is taken too, though only the session lists it.
  const taken = new Set([...Object.keys(status.TCP ?? {}), ...Object.values(status.Foreground ?? {}).flatMap((session) => Object.keys(session.TCP ?? {}))])
  const free = Array.from({ length: 100 }, (_, n) => port + n).find((candidate) => !taken.has(String(candidate)))
  if (free === undefined) {
    return { kind: 'off', detail: `Serve on ${shared[0]} also sends other paths to other services, and every port from ${port} to ${port + 99} is taken. Free an HTTPS port in Tailscale, then check again.` }
  }
  return {
    kind: 'setup',
    reason: `Serve on ${shared[0]} also sends other paths to other services, so a phone could reach the wrong one. Give this app an HTTPS port of its own.`,
    command: `${tailscale} serve --bg --https=${free} http://127.0.0.1:${port}`,
  }
}
