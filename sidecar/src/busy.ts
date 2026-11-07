/**
 * Tells Rust while the store has work in flight, so an update waits to restart the app until the work is done. The
 * pass is asked for before a turn's first commit and before work a crash cut off resumes, and given back once no send
 * is committing and every live task is idle. A tool parked on a sign-in is idle, and so is a task that waits only on
 * idle tasks: they do no work until the person signs in, and they resume after a restart, so an update may restart
 * through them. A task that waits on a tool that finished is about to go on, so it is not idle.
 * While an update installs, Rust refuses the pass, and the send with it.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, TaskGraph } from '@earendil-works/pi-durable'
import type { Host } from './host'

/** How long a refused pass waits before it asks again. An installing update restarts the app, or it fails and the gate opens. */
const PASS_RETRY_MS = 1000

/** Waits `ms`, or less once `stop` aborts. */
function pause(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      stop.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    stop.addEventListener('abort', done)
  })
}

/** Whether any live task does work now or is about to. A blocked task never runs here. */
function working(graph: TaskGraph, parked: ReadonlySet<string>): boolean {
  const idle = (id: string): boolean => {
    if (parked.has(id)) return true
    const task = graph.tasks[id]
    if (task === undefined || task.blocked !== undefined) return task !== undefined
    if (task.state.status !== 'waiting') return false
    // A finished child is gone from the graph. A task whose children all finished is about to go on, and one that
    // still waits on a live child is idle when every live child is.
    const live = task.state.on.map(String).filter((child) => graph.tasks[child] !== undefined)
    return live.length > 0 && live.every(idle)
  }
  return Object.keys(graph.tasks).some((id) => !idle(id))
}

export class Busy {
  readonly #host: Host
  /** Whether Rust said yes to the pass and it was not given back since. */
  #held = false
  #graph: TaskGraph = { tasks: {} }
  /** The ids of running tool tasks parked on a sign-in, which do no work until the person signs in. */
  readonly #parked = new Set<string>()
  #sends = 0
  /** Ends every wait for the pass once the sidecar closes. */
  readonly #closing = new AbortController()
  /** Changes reach Rust one at a time, in order. */
  #told: Promise<unknown> = Promise.resolve()

  constructor(host: Host) {
    this.#host = host
  }

  /**
   * Follows the store's live tasks from the graph as it is now, so work a crash cut off asks for the pass before it
   * resumes. Resolves false when that work has no pass, which means an update is installing and restarts the app.
   */
  async watch(harness: Harness): Promise<boolean> {
    const graph = await harness.watchTaskGraph(BACKGROUND_CONTEXT)
    this.#graph = graph.value
    const ok = await this.#settle().then(
      () => true,
      () => false,
    )
    graph.start(async (call) => {
      if (call.kind !== 'value') return
      this.#graph = call.value
      await this.#follow()
    })
    return ok
  }

  /**
   * Settles for work already under way. A refusal means an update is installing and restarts the app soon: the work is
   * committed step by step and resumes after it. The next change asks again.
   */
  #follow(): Promise<void> {
    return this.#settle().catch((error: unknown) => {
      console.error(`the update gate refused the engine's pass: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Asks for the pass until Rust gives it, for work that must not go on without it, and resolves true once it is held
   * or no work needs it. While an update installs, it asks again each second. Resolves false once `stop` aborts or
   * the sidecar closes.
   */
  async pass(stop?: AbortSignal): Promise<boolean> {
    const ended = stop === undefined ? this.#closing.signal : AbortSignal.any([stop, this.#closing.signal])
    for (;;) {
      if (ended.aborted) return false
      try {
        await this.#settle()
        return true
      } catch {
        await pause(PASS_RETRY_MS, ended)
      }
    }
  }

  /** Ends every wait for the pass, as the sidecar closes. */
  close(): void {
    this.#closing.abort()
  }

  /** Brings Rust's pass in line with the work now. Rejects with Rust's refusal when this call asked and was refused. */
  #settle(): Promise<void> {
    const told = this.#told.then(async () => {
      const busy = this.#sends > 0 || working(this.#graph, this.#parked)
      if (busy === this.#held) return
      await this.#host.request('busy', { busy })
      this.#held = busy
    })
    this.#told = told.catch(() => {})
    return told
  }

  /**
   * Holds the pass while `commit` runs, so a send never starts while an update installs. Throws Rust's refusal
   * without committing anything.
   */
  async during<T>(commit: () => Promise<T>): Promise<T> {
    this.#sends += 1
    try {
      await this.#settle()
      return await commit()
    } finally {
      this.#sends -= 1
      await this.#follow()
    }
  }

  /**
   * `during` for work that goes on by itself, such as a turn a sign-in lets go: while an update installs it asks again
   * each second instead of failing, so an install that fails does not leave the work waiting. Resolves undefined, with
   * nothing committed, once the sidecar closes. An install that succeeds restarts the app, and the work goes on then.
   */
  async duringWhenAllowed<T>(commit: () => Promise<T>): Promise<T | undefined> {
    this.#sends += 1
    try {
      if (!(await this.pass())) return undefined
      return await commit()
    } finally {
      this.#sends -= 1
      await this.#follow()
    }
  }

  /**
   * Gives the pass back while the tool `task` waits on `wait` for a sign-in. Once the wait ends, the tool goes on only
   * with the pass, so an update that started installing meanwhile holds it until the app restarts or the install fails.
   * A stop through `stop`, or the sidecar closing, ends that wait too.
   */
  async parked<T>(task: string, wait: () => Promise<T>, stop: AbortSignal | undefined): Promise<T> {
    this.#parked.add(task)
    void this.#follow()
    let result: T
    try {
      result = await wait()
    } catch (error) {
      this.#parked.delete(task)
      await this.#follow()
      throw error
    }
    this.#parked.delete(task)
    if (await this.pass(stop)) return result
    // A stop ends the tool. A sidecar that closes leaves it unfinished until Pi ends it as the store closes, so it
    // resumes after the restart.
    stop?.throwIfAborted()
    return new Promise<never>((_, reject) => stop?.addEventListener('abort', () => reject(stop.reason), { once: true }))
  }
}
