/**
 * The phone service: a small HTTP API on loopback that a paired phone or tablet reaches through the person's own
 * Tailscale Serve. `docs/adr/0001-mobile-service-over-tailscale-serve.md` is its contract. It does only what the route
 * table in `Mobile` lists, each route through the same store and chat code the window's methods use, and it sends a
 * phone only `chat` events.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { extname, join } from 'node:path'
import type { Models } from '@earendil-works/pi-ai'
import { arr, compile, int, map, nullable, obj, opt, str, type Validator } from '@earendil-works/pi-schema'
import type { Server } from 'bun'
import { renderSVG } from 'uqr'
import { type Chats, inside } from './chat'
import { skipped } from './folder'
import type { Logins } from './inference'
import { model, offeredModels, refuseUnrunnable } from './methods'
import { savePicture } from './pictures'
import type { Computer, MobileChat, MobilePairing, ModelFile, PairedDevice, SidecarEvent } from './protocol'
import { deviceDraft, type Store } from './store'

/** Where Tailscale's command line lives in the Mac app, for a Mac that has no `tailscale` on its PATH. */
const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

/** The model files a phone can list and read, by extension, with the content type each is sent as. */
const MODEL_TYPES: Record<string, string> = { '.stl': 'model/stl', '.3mf': 'model/3mf', '.glb': 'model/gltf-binary' }

/** A stream with no change for this long gets a comment line, so nothing between it and the phone closes it. */
const KEEPALIVE_MS = 15_000

/** The one answer to a code that is wrong, expired, or used, so a guess learns nothing about the live one. */
const BAD_CODE = 'This code is wrong, expired, or used. Show a new code on the computer.'

/** What `tailscale serve status --json` says, as far as this app reads it: each served address and where `/` goes. */
const serveStatus = compile(
  obj({ Web: opt(map(obj({ Handlers: opt(map(obj({ Proxy: opt(str()) }, { open: true }))) }, { open: true }))) }, { open: true }),
)

const sha256 = (text: string) => createHash('sha256').update(text).digest()

/** A refusal with its HTTP status. Every other error answers 500. */
class Refused extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404,
    message: string,
  ) {
    super(message)
  }
}

/** The one live pairing code, kept as its hash. A new one replaces it, and it works once. */
class Pairing {
  #live: { hash: Buffer; expiresMs: number } | undefined
  readonly #ttlMs: number

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs
  }

  issue(): { code: string; expiresMs: number } {
    const code = randomBytes(16).toString('base64url')
    const expiresMs = Date.now() + this.#ttlMs
    this.#live = { hash: sha256(code), expiresMs }
    return { code, expiresMs }
  }

  /** Whether `code` is the live code, unexpired. A match takes it away at once, expired or not, so it works once. */
  redeem(code: string): boolean {
    const live = this.#live
    if (live === undefined || !timingSafeEqual(live.hash, sha256(code))) return false
    this.#live = undefined
    return Date.now() <= live.expiresMs
  }
}

/** The open event streams. The sidecar's `emit` hands each event here too, and only `chat` events go on. */
export class PhoneEvents {
  readonly #open = new Set<(line: string) => void>()
  readonly #encoder = new TextEncoder()

  send(event: SidecarEvent): void {
    if (event.type !== 'chat') return
    for (const write of this.#open) write(`data: ${JSON.stringify(event)}\n\n`)
  }

  open(): Response {
    let write: (line: string) => void
    let keepalive: ReturnType<typeof setInterval>
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        write = (line) => controller.enqueue(this.#encoder.encode(line))
        this.#open.add(write)
        keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS)
        write(': open\n\n')
      },
      cancel: () => {
        this.#open.delete(write)
        clearInterval(keepalive)
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }
}

export interface MobileOptions {
  store: Store
  chats: Chats
  models: Models
  logins: Logins
  version: string
  /** The folder a phone draft's pictures are kept in, as the window's pasted pictures are. */
  pictures: string
  events: PhoneEvents
  port: number
  pairingTtlMs: number
}

type Params = Record<string, string>
/** A route: an open one takes no token, and every other one runs for the paired device whose token the request carries. */
type Route = { method: 'GET' | 'POST' | 'PUT'; path: string } & (
  | { open: true; run(request: Request): Promise<Response> }
  | { open?: false; run(request: Request, params: Params, device: PairedDevice): Promise<Response> }
)

const EVENTS = '/api/v1/events'

/** Matches a path to a route's pattern: `:name` takes one part, and `*name` takes the rest, at least one part. */
function match(pattern: string, path: string): Params | undefined {
  const want = pattern.split('/')
  const got = path.split('/')
  const params: Params = {}
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part)
    } catch {
      throw new Refused(400, `${part} is not a path part`)
    }
  }
  for (const [at, part] of want.entries()) {
    const seen = got[at]
    if (seen === undefined) return undefined
    if (part.startsWith('*')) {
      const rest = got.slice(at)
      if (rest.includes('')) return undefined
      params[part.slice(1)] = rest.map(decode).join('/')
      return params
    }
    if (part.startsWith(':')) {
      if (seen === '') return undefined
      params[part.slice(1)] = decode(seen)
    } else if (part !== seen) return undefined
  }
  return got.length === want.length ? params : undefined
}

async function body<T>(request: Request, schema: Validator<T>): Promise<T> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new Refused(400, 'The body is not JSON.')
  }
  if (!schema.check(value)) throw new Refused(400, schema.errors(value).map((e) => `${e.path || '/'} ${e.message}`).join('; '))
  return value
}

const json = (value: unknown) => Response.json(value)

/** The model files in a project folder, newest first. Names the file list skips, and links, are left out. */
function modelFiles(root: string): ModelFile[] {
  const files: ModelFile[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (skipped(entry.name)) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && MODEL_TYPES[extname(entry.name).toLowerCase()] !== undefined) {
        const { size, mtimeMs } = statSync(join(root, path))
        files.push({ rel: path, size, modifiedMs: mtimeMs })
      }
    }
  }
  if (existsSync(root)) walk('')
  return files.sort((a, b) => b.modifiedMs - a.modifiedMs)
}

const drafted = compile(obj({ text: str(), pictures: arr(obj({ name: str({ pattern: '^[^./][^/]*$' }), data: str() })) }))
const sent = compile(obj({ rev: int() }))
const roles = compile(obj({ lead: opt(model), helper: opt(nullable(model)) }))
const pairs = compile(obj({ code: str(), name: str({ minLength: 1, maxLength: 100 }) }))

/** The phone service. A port it cannot listen on leaves it off, with the reason, and the rest of the sidecar runs. */
export class Mobile {
  readonly #o: MobileOptions
  readonly #pairing: Pairing
  readonly #listening: { on: true; server: Server<undefined> } | { on: false; detail: string }

  constructor(options: MobileOptions) {
    this.#o = options
    this.#pairing = new Pairing(options.pairingTtlMs)
    const routes = this.#routes()
    try {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: options.port,
        fetch: async (request, server) => {
          const path = new URL(request.url).pathname
          try {
            for (const route of routes) {
              const params = route.method === request.method ? match(route.path, path) : undefined
              if (params === undefined) continue
              if (route.open) return await route.run(request)
              const device = await this.#device(request)
              // An event stream stays open with nothing to send for as long as no chat changes.
              if (route.path === EVENTS) server.timeout(request, 0)
              return await route.run(request, params, device)
            }
            throw new Refused(404, `no route ${request.method} ${path}`)
          } catch (error) {
            if (error instanceof Refused) return Response.json({ error: error.message }, { status: error.status })
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
          }
        },
      })
      this.#listening = { on: true, server }
    } catch (error) {
      const detail = `The phone service could not listen on port ${options.port}: ${error instanceof Error ? error.message : String(error)}. Another copy of the app may be serving phones.`
      console.error(detail)
      this.#listening = { on: false, detail }
    }
  }

  /** The full surface a paired device can reach. Every route but `pair` needs the device's token. */
  #routes(): Route[] {
    const { store, chats, models, logins, pictures } = this.#o
    const project = async ({ project: id }: Params) => {
      const found = (await store.projects()).find((p) => p.id === id)
      if (found === undefined) throw new Refused(404, `no project ${id}`)
      return found
    }
    return [
      { method: 'POST', path: '/api/v1/pair', open: true, run: (request) => this.#pair(request) },
      { method: 'GET', path: '/api/v1/computer', run: async (_, __, device) => json({ ...(await this.#computer()), device }) },
      { method: 'GET', path: '/api/v1/models', run: async () => json(await offeredModels(store, logins)) },
      {
        method: 'GET',
        path: '/api/v1/chats',
        run: async () => {
          const status = await chats.status()
          const listed = (await store.projects()).flatMap(({ id, title, createdMs, model, helper }): MobileChat[] => {
            // A project made after the status was read is listed next time.
            const of = status[id]
            return of === undefined ? [] : [{ id, title, createdMs, lead: model, helper, status: of }]
          })
          return json(listed.sort((a, b) => b.status.lastMs - a.status.lastMs))
        },
      },
      { method: 'GET', path: '/api/v1/chats/:project', run: async (_, params) => json(await chats.open((await project(params)).id)) },
      { method: 'GET', path: EVENTS, run: async () => this.#o.events.open() },
      {
        method: 'PUT',
        path: '/api/v1/chats/:project/draft',
        run: async (request, params, device) => {
          const { id } = await project(params)
          const { text, pictures: added } = await body(request, drafted)
          const attachments = added.map(({ name, data }) => savePicture(pictures, name, data))
          return json({ rev: await store.setDraft(deviceDraft(device.id, id), { text, attachments }) })
        },
      },
      {
        method: 'POST',
        path: '/api/v1/chats/:project/send',
        run: async (request, params, device) => {
          const { id } = await project(params)
          const { rev } = await body(request, sent)
          return json({ project: await chats.send(deviceDraft(device.id, id), rev, id) })
        },
      },
      {
        method: 'PUT',
        path: '/api/v1/chats/:project/roles',
        run: async (request, params) => {
          const { id } = await project(params)
          const { lead, helper } = await body(request, roles)
          if (lead !== undefined) refuseUnrunnable(models, lead)
          if (helper !== undefined && helper !== null) refuseUnrunnable(models, helper)
          if (lead !== undefined) await store.setLead(id, lead)
          if (helper !== undefined) await store.setHelper(id, helper)
          return json(await store.pairFor(id))
        },
      },
      { method: 'GET', path: '/api/v1/chats/:project/files', run: async (_, params) => json(modelFiles(join(store.projectsDir, (await project(params)).id))) },
      {
        method: 'GET',
        path: '/api/v1/chats/:project/files/*rel',
        run: async (_, params) => {
          const folder = join(store.projectsDir, (await project(params)).id)
          const rel = params.rel ?? ''
          const type = MODEL_TYPES[extname(rel).toLowerCase()]
          const missing = new Refused(404, `${rel} is not a model file in this chat`)
          if (type === undefined || rel.split('/').some(skipped)) throw missing
          let path: string
          try {
            path = inside(folder, rel)
          } catch {
            throw missing
          }
          return new Response(Bun.file(path), { headers: { 'content-type': type } })
        },
      },
    ]
  }

  /** Pairs a device with the live code. The code is taken before anything waits, so two redeems of it cannot both pair. */
  async #pair(request: Request): Promise<Response> {
    const { code, name } = await body(request, pairs)
    if (!this.#pairing.redeem(code)) throw new Refused(403, BAD_CODE)
    const token = randomBytes(32).toString('base64url')
    const device = await this.#o.store.addDevice(name, sha256(token).toString('hex'))
    return json({ token, device, computer: await this.#computer() })
  }

  /** The paired device the request's token belongs to. */
  async #device(request: Request): Promise<PairedDevice> {
    const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    const device = token === undefined ? undefined : await this.#o.store.deviceFor(sha256(token).toString('hex'))
    if (device === undefined) throw new Refused(401, 'This device is not paired with this computer.')
    return device
  }

  async #computer(): Promise<Computer> {
    return { id: await this.#o.store.computer(), name: hostname().replace(/\.local$/, ''), version: this.#o.version }
  }

  /**
   * A new pairing code, shown as a QR image of the URL Tailscale Serve gives the service, when Serve forwards to it.
   * Otherwise the command that sets Serve up, or why no phone can reach the service.
   */
  async pair(): Promise<MobilePairing> {
    if (!this.#listening.on) return { kind: 'off', detail: this.#listening.detail }
    const port = this.#listening.server.port
    const cli = Bun.which('tailscale') ?? (existsSync(MAC_TAILSCALE) ? MAC_TAILSCALE : undefined)
    if (cli === undefined) return { kind: 'off', detail: 'Tailscale is not installed on this computer. Install it, sign in, and try again.' }
    const run = Bun.spawn([cli, 'serve', 'status', '--json'], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    if (exit !== 0) return { kind: 'off', detail: `Tailscale did not answer: ${err.trim() || `it stopped with exit ${exit}`}` }
    const status: unknown = out.trim() === '' ? {} : JSON.parse(out)
    if (!serveStatus.check(status)) throw new Error(`tailscale serve status --json printed what this app cannot read: ${out.slice(0, 200)}`)
    const forwards = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
    const served = Object.entries(status.Web ?? {}).find(([, web]) => forwards.includes(web.Handlers?.['/']?.Proxy ?? ''))?.[0]
    if (served === undefined) return { kind: 'setup', command: `tailscale serve --bg --https=${port} http://127.0.0.1:${port}` }
    const { code, expiresMs } = this.#pairing.issue()
    const url = `https://${served.replace(/:443$/, '')}/pair?code=${code}`
    return { kind: 'ready', url, svg: renderSVG(url), expiresMs }
  }

  stop(): void {
    if (this.#listening.on) void this.#listening.server.stop(true)
  }
}
