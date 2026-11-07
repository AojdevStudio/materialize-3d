import { createInterface } from 'node:readline'
import { bool, compile, int, lit, obj, opt, str, union, unknown, type Validator } from '@earendil-works/pi-schema'
import type { HostRequest, HostRequests, Method, Methods, Outbound, SidecarEvent } from './protocol'

const inbound = compile(
  union([
    obj({ kind: lit('call'), id: int(), method: str(), params: unknown() }),
    obj({ kind: lit('answer'), id: int(), ok: bool(), value: opt(unknown()), error: opt(str()) }),
  ]),
)

/** One method the window can call: how its params parse, and what it does. */
export interface Handler<M extends Method> {
  params: Validator<Methods[M]['params']>
  run(params: Methods[M]['params']): Promise<Methods[M]['result']>
}

export type Handlers = { [M in Method]: Handler<M> }

/**
 * The sidecar's end of the pipe to Rust. Calls from the window arrive on stdin and get one reply each. Requests
 * the sidecar makes of Rust go out on stdout and resolve with Rust's answer.
 */
export class Host {
  #nextRequest = 1
  readonly #waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  readonly #write: (line: string) => void

  constructor(write: (line: string) => void) {
    this.#write = write
  }

  #send(message: Outbound): void {
    this.#write(`${JSON.stringify(message)}\n`)
  }

  emit(event: SidecarEvent): void {
    this.#send({ kind: 'event', event })
  }

  request<R extends HostRequest>(method: R, params: HostRequests[R]['params']): Promise<HostRequests[R]['result']> {
    const id = this.#nextRequest++
    const { promise, resolve, reject } = Promise.withResolvers<HostRequests[R]['result']>()
    this.#waiting.set(id, { resolve: (value) => resolve(value as HostRequests[R]['result']), reject })
    this.#send({ kind: 'request', id, method, params })
    return promise
  }

  /**
   * Reads stdin until it closes, then lets every call it accepted finish. A line that is not a message of the
   * protocol is a bug in Rust, so it fails the process loudly rather than being skipped.
   */
  async serve(handlers: Handlers, input: NodeJS.ReadableStream): Promise<void> {
    const accepted = new Set<Promise<void>>()
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (line.trim() === '') continue
      const message: unknown = JSON.parse(line)
      if (!inbound.check(message)) throw new Error(`not a protocol message: ${line.slice(0, 200)}`)
      if (message.kind === 'answer') {
        const waiting = this.#waiting.get(message.id)
        if (waiting === undefined) throw new Error(`an answer to no request: ${message.id}`)
        this.#waiting.delete(message.id)
        if (message.ok) waiting.resolve(message.value ?? null)
        else waiting.reject(new Error(message.error ?? 'the app refused the request'))
        continue
      }
      const call = this.#call(handlers, message.id, message.method, message.params)
      accepted.add(call)
      void call.finally(() => accepted.delete(call))
    }
    // Rust answers nothing more, so a call waiting on it fails now instead of never.
    for (const waiting of this.#waiting.values()) waiting.reject(new Error('the app closed the pipe'))
    this.#waiting.clear()
    await Promise.allSettled(accepted)
  }

  async #call(handlers: Handlers, id: number, method: string, params: unknown): Promise<void> {
    try {
      if (!Object.hasOwn(handlers, method)) throw new Error(`no method ${method}`)
      const handler = handlers[method as Method] as Handler<Method>
      if (!handler.params.check(params)) {
        const why = handler.params.errors(params).map((e) => `${e.path || '/'} ${e.message}`)
        throw new Error(`bad params for ${method}: ${why.join('; ')}`)
      }
      this.#send({ kind: 'reply', id, ok: true, value: await handler.run(params) })
    } catch (error) {
      this.#send({ kind: 'reply', id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
