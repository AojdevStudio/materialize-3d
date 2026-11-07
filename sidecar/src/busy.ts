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

/** Whether any live task does work now or is about to. A blocked task never runs here. */
function working(graph: TaskGraph, parked: ReadonlySet<string>): boolean {
  const idle = (id: string): boolean => {
    if (parked.has(id)) return true
    const task = graph.tasks[id]
    if (task === undefined) return false
    if (task.blocked !== undefined) return true
    return task.state.status === 'waiting' && task.state.on.every((child) => idle(String(child)))
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

  /** Gives the pass back while the tool `task` waits on `wait` for a sign-in, and asks for it again when it goes on. */
  async parked<T>(task: string, wait: () => Promise<T>): Promise<T> {
    this.#parked.add(task)
    void this.#follow()
    try {
      return await wait()
    } finally {
      this.#parked.delete(task)
      await this.#follow()
    }
  }
}
