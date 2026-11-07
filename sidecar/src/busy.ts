/**
 * Tells Rust while the store has work in flight, so an update waits to restart the app until the work is done. The
 * pass is asked for before a turn's first commit, and given back once no task is live and no send is committing.
 * While an update installs, Rust refuses the pass, and the send with it.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { Host } from './host'

export class Busy {
  readonly #host: Host
  /** Whether Rust holds the pass for this sidecar. */
  #held = false
  #tasks = 0
  #sends = 0
  /** Changes reach Rust one at a time, in order. */
  #told: Promise<unknown> = Promise.resolve()

  constructor(host: Host) {
    this.#host = host
  }

  /** Follows the store's live tasks: a run, its tools, a child, a sleeping retry. */
  async watch(harness: Harness): Promise<void> {
    const graph = await harness.watchTaskGraph(BACKGROUND_CONTEXT)
    graph.start(async (call) => {
      if (call.kind !== 'value') return
      this.#tasks = Object.keys(call.value.tasks).length
      await this.#settle()
    })
  }

  #settle(): Promise<unknown> {
    const busy = this.#tasks > 0 || this.#sends > 0
    if (busy === this.#held) return this.#told
    this.#held = busy
    this.#told = this.#told.then(() => this.#host.request('busy', { busy })).catch((error: unknown) => {
      // A task that resumes while an update installs runs anyway: its work is committed step by step.
      console.error(`the update gate refused the engine's pass: ${error instanceof Error ? error.message : String(error)}`)
      this.#held = false
    })
    return this.#told
  }

  /**
   * Holds the pass while `commit` runs, so a send never starts while an update installs. Throws Rust's refusal
   * without committing anything.
   */
  async during<T>(commit: () => Promise<T>): Promise<T> {
    this.#sends += 1
    try {
      if (!this.#held) {
        await this.#told
        await this.#host.request('busy', { busy: true })
        this.#held = true
      }
      return await commit()
    } finally {
      this.#sends -= 1
      await this.#settle()
    }
  }
}
