/**
 * Tells Rust while the store has work in flight, so an update waits to restart the app until the work is done. The
 * pass is asked for before a turn's first commit and before work a crash cut off resumes, and given back once no task
 * is pending or running and no send is committing. A task that waits, sleeps, or holds a sign-in wait does no work
 * until something wakes it, and it resumes after a restart, so an update may restart through it.
 * While an update installs, Rust refuses the pass, and the send with it.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, TaskGraph } from '@earendil-works/pi-durable'
import type { Host } from './host'

/** Tasks doing work now. A blocked task never runs here. */
const working = (graph: TaskGraph) =>
  Object.values(graph.tasks).filter((task) => (task.state.status === 'pending' || task.state.status === 'running') && task.blocked === undefined).length

export class Busy {
  readonly #host: Host
  /** Whether Rust said yes to the pass and it was not given back since. */
  #held = false
  #tasks = 0
  /** Running tool tasks parked on a sign-in, which do no work until the person signs in. */
  #parked = 0
  #sends = 0
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
    this.#tasks = working(graph.value)
    const ok = await this.#settle().then(
      () => true,
      () => false,
    )
    graph.start(async (call) => {
      if (call.kind !== 'value') return
      this.#tasks = working(call.value)
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

  /** Brings Rust's pass in line with the work now. Rejects with Rust's refusal when this call asked and was refused. */
  #settle(): Promise<void> {
    const told = this.#told.then(async () => {
      const busy = this.#sends > 0 || this.#tasks - this.#parked > 0
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

  /** Gives the pass back while a running tool waits on `wait` for a sign-in, and asks for it again when it goes on. */
  async parked<T>(wait: () => Promise<T>): Promise<T> {
    this.#parked += 1
    void this.#follow()
    try {
      return await wait()
    } finally {
      this.#parked -= 1
      await this.#follow()
    }
  }
}
