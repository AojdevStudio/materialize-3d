/**
 * The phone service: a small HTTP API on loopback that a paired phone or tablet reaches through the person's own
 * Tailscale Serve. `docs/adr/0001-mobile-service-over-tailscale-serve.md` is its contract. It does only what the route
 * table in `Mobile` lists, each route through the same store and chat code the window's methods use, and it sends a
 * phone only `chat` and `project` events.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Models } from '@earendil-works/pi-ai'
import { arr, bool, compile, int, map, nullable, obj, opt, str, type Validator } from '@earendil-works/pi-schema'
import type { Server } from 'bun'
import { renderSVG } from 'uqr'
import { type Chats, inside } from './chat'
import { skipped } from './folder'
import type { Logins } from './inference'
import { model, offeredModels, saveRoles } from './methods'
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

/** The most a pairing request may carry, since it comes before any token. */
const PAIR_BODY_BYTES = 4096

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
    },
    { open: true },
  ),
)

const sha256 = (text: string) => createHash('sha256').update(text).digest()

/** A refusal with its HTTP status. Every other error answers 500. */
class Refused extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 413,
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

/** An open event stream: the device it was opened for, and how to write to it and end it. */
type Stream = { device: string; write(line: string): void; end(): void }

/**
 * The open event streams, each for the paired device that opened it. The sidecar's `emit` hands each event here too,
 * and only `chat` and `project` events go on. Forgetting a device ends its streams.
 */
export class PhoneEvents {
  readonly #open = new Set<Stream>()
  readonly #encoder = new TextEncoder()

  send(event: SidecarEvent): void {
    if (event.type !== 'chat' && event.type !== 'project') return
    for (const stream of this.#open) stream.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  /** Ends every stream `device` opened. */
  close(device: string): void {
    for (const stream of this.#open) if (stream.device === device) stream.end()
  }

  open(device: string): Response {
    let open: Stream
    let keepalive: ReturnType<typeof setInterval>
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        open = {
          device,
          write: (line) => controller.enqueue(this.#encoder.encode(line)),
          end: () => {
            this.#open.delete(open)
            clearInterval(keepalive)
            controller.close()
          },
        }
        this.#open.add(open)
        keepalive = setInterval(() => open.write(': keepalive\n\n'), KEEPALIVE_MS)
        open.write(': open\n\n')
      },
      cancel: () => {
        this.#open.delete(open)
        clearInterval(keepalive)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
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
  /** Tells the window and every paired device's open stream. */
  emit(event: SidecarEvent): void
  port: number
  pairingTtlMs: number
}

type Params = Record<string, string>
/** A route a paired device can call. It runs for the device whose token the request carries. */
type Route = { method: 'GET' | 'POST' | 'PUT'; path: string; run(request: Request, params: Params, device: PairedDevice): Promise<Response> }

/** The one route that takes no token: a device redeems the code on the computer's screen here. */
const PAIR = '/api/v1/pair'
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

/** The request's body as text, refused once it passes `limit` bytes, before the rest is read. */
async function capped(request: Request, limit: number): Promise<string> {
  const tooLarge = new Refused(413, `The body is over ${limit} bytes.`)
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw tooLarge
  const chunks: Uint8Array[] = []
  let read = 0
  for await (const chunk of request.body ?? []) {
    read += chunk.byteLength
    if (read > limit) throw tooLarge
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function body<T>(request: Request, schema: Validator<T>, limit = Number.POSITIVE_INFINITY): Promise<T> {
  let value: unknown
  try {
    value = JSON.parse(await capped(request, limit))
  } catch (error) {
    if (error instanceof Refused) throw error
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
  walk('')
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
        // Bun's development mode answers routes of its own before `fetch`, and a shared port lets another process take
        // requests, so neither is left to Bun's defaults.
        development: false,
        reusePort: false,
        fetch: async (request, server) => {
          const path = new URL(request.url).pathname
          try {
            // Tailscale marks a request that came in over Funnel, from the public internet. The service is the tailnet's.
            if (request.headers.has('tailscale-funnel-request')) throw new Refused(403, 'This service answers only on your tailnet.')
            if (request.method === 'POST' && path === PAIR) return await this.#pair(request)
            // Every other request, to a route or not, shows a paired device's token first, so a stranger learns nothing.
            const device = await this.#device(request)
            for (const route of routes) {
              const params = route.method === request.method ? match(route.path, path) : undefined
              if (params === undefined) continue
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

  /** The full surface a paired device can reach, beside `PAIR`. Each route needs the device's token. */
  #routes(): Route[] {
    const { store, chats, logins, pictures } = this.#o
    const project = async ({ project: id }: Params) => {
      const found = (await store.projects()).find((p) => p.id === id)
      if (found === undefined) throw new Refused(404, `no project ${id}`)
      return found
    }
    /**
     * A chat's folder where it really is, or undefined before the agent made it. A folder that is a link is refused, so
     * the files a phone lists and reads stay under the projects folder.
     */
    const folderOf = async (params: Params) => {
      const { id } = await project(params)
      const folder = join(store.projectsDir, id)
      if (!existsSync(folder)) return undefined
      const real = join(realpathSync.native(store.projectsDir), id)
      if (realpathSync.native(folder) !== real) throw new Refused(404, `${id} is not a chat folder here`)
      return real
    }
    return [
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
      { method: 'GET', path: EVENTS, run: async (_, __, device) => this.#o.events.open(device.id) },
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
          const { model: lead, helper } = await saveRoles(this.#o, id, await body(request, roles))
          return json({ lead, helper })
        },
      },
      {
        method: 'GET',
        path: '/api/v1/chats/:project/files',
        run: async (_, params) => {
          const folder = await folderOf(params)
          return json(folder === undefined ? [] : modelFiles(folder))
        },
      },
      {
        method: 'GET',
        path: '/api/v1/chats/:project/files/*rel',
        run: async (_, params) => {
          const folder = await folderOf(params)
          const rel = params.rel ?? ''
          const type = MODEL_TYPES[extname(rel).toLowerCase()]
          const missing = new Refused(404, `${rel} is not a model file in this chat`)
          if (folder === undefined || type === undefined || rel.split('/').some(skipped)) throw missing
          const named = join(folder, rel)
          try {
            // The list leaves links out, so a read takes only the file the name spells, with no link on its way.
            if (realpathSync.native(inside(folder, rel)) !== named) throw missing
          } catch {
            throw missing
          }
          // The bytes stream from the file opened here, checked to be the one named, so a swap after the check serves
          // nothing, and a large model is never held in memory whole. The stream closes the file when it ends.
          const fd = openSync(named, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const opened = fstatSync(fd)
            const there = lstatSync(named)
            if (!opened.isFile() || opened.ino !== there.ino || opened.dev !== there.dev || realpathSync.native(named) !== named) throw missing
          } catch (error) {
            closeSync(fd)
            throw error
          }
          const bytes = Readable.toWeb(createReadStream(named, { fd })) as ReadableStream<Uint8Array>
          return new Response(bytes, { headers: { 'content-type': type } })
        },
      },
    ]
  }

  /** Pairs a device with the live code. The code is taken before anything waits, so two redeems of it cannot both pair. */
  async #pair(request: Request): Promise<Response> {
    const { code, name } = await body(request, pairs, PAIR_BODY_BYTES)
    if (!this.#pairing.redeem(code)) throw new Refused(403, BAD_CODE)
    const token = randomBytes(32).toString('base64url')
    const { store, emit } = this.#o
    const device = await store.addDevice(name, sha256(token).toString('hex'))
    // Settings shows the new device, and that its code is spent, without being asked.
    emit({ type: 'paired', device, devices: await store.devices() })
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
    // The Mac app's own executable answers as the command line only when told to, and the sidecar's shell gives no hint.
    const run = Bun.spawn([cli, 'serve', 'status', '--json'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TAILSCALE_BE_CLI: '1' } })
    const [out, err, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    if (exit !== 0) return { kind: 'off', detail: `Tailscale did not answer: ${err.trim() || `it stopped with exit ${exit}`}` }
    const status: unknown = out.trim() === '' ? {} : JSON.parse(out)
    if (!serveStatus.check(status)) throw new Error(`tailscale serve status --json printed what this app cannot read: ${out.slice(0, 200)}`)
    const tailscale = cli === MAC_TAILSCALE ? `'${MAC_TAILSCALE}'` : 'tailscale'
    const forwards = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
    const portOf = (served: string) => served.slice(served.lastIndexOf(':') + 1)
    // An address the QR can name takes HTTPS, and sends every path to this service, so no other mount Tailscale prefers
    // takes the pairing code or a device's token. A plain HTTP listener, or one shared with other paths, is passed over.
    const ours = Object.entries(status.Web ?? {}).flatMap(([at, web]) => {
      const handlers = Object.entries(web.Handlers ?? {})
      return status.TCP?.[portOf(at)]?.HTTPS === true && handlers.length === 1 && handlers[0]?.[0] === '/' && forwards.includes(handlers[0][1].Proxy ?? '') ? [at] : []
    })
    // A private address wins over a public one, in whatever order Serve lists them.
    const served = ours.find((at) => status.AllowFunnel?.[at] !== true)
    const [open] = ours
    if (served === undefined && open !== undefined) {
      return { kind: 'off', detail: `Tailscale Funnel makes ${open} public on the internet. Turn Funnel off for it with ${tailscale} funnel --https=${portOf(open)} off, then check again.` }
    }
    if (served === undefined) return { kind: 'setup', command: `${tailscale} serve --bg --https=${port} http://127.0.0.1:${port}` }
    const { code, expiresMs } = this.#pairing.issue()
    const url = `https://${served.replace(/:443$/, '')}/pair?code=${code}`
    return { kind: 'ready', url, svg: renderSVG(url), expiresMs }
  }

  /** Forgets a paired device: its token stops working, and the event streams it holds open end now. */
  async forget(device: string): Promise<PairedDevice[]> {
    const left = await this.#o.store.forgetDevice(device)
    this.#o.events.close(device)
    return left
  }

  stop(): void {
    if (this.#listening.on) void this.#listening.server.stop(true)
  }
}
