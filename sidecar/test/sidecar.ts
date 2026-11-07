type Message = Record<string, unknown>

/**
 * The sidecar as Rust runs it: a child process spoken to over stdin and stdout, one JSON object per line. The test
 * plays Rust. Like Rust, it reads stdout all the time, since the sidecar stops when no one drains it. It answers the
 * sidecar's Keychain requests from `keychain`, which stands in for the macOS Keychain, and its update-gate requests,
 * recording each in `gate` and refusing the pass while `gate.installing` is set, as an installing update does. `hold`
 * may hold a request's answer, read when the request came, until it calls `answer`, as a slow Keychain does.
 */
export function spawnSidecar(
  dataDir: string,
  projectsDir: string,
  keychain = new Map<string, string>(),
  options: { script?: string; env?: Record<string, string>; version?: string; hold?: (request: Message, answer: () => void) => void } = {},
) {
  const entry = options.script === undefined ? 'src/main.ts' : 'test/fixtures/scripted-sidecar.ts'
  const child = Bun.spawn(['bun', entry, '--app-version', options.version ?? '9.9.9', '--data', dataDir, '--projects', projectsDir], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, ...options.env, ...(options.script === undefined ? {} : { M3D_SCRIPT: options.script }) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const gate = { installing: false, requests: [] as boolean[] }

  /** Reads the Keychain or the gate now, and returns how to send that answer, now or later. */
  function answer(request: Message): () => void {
    if (request.method === 'busy') {
      const { busy } = request.params as { busy: boolean }
      gate.requests.push(busy)
      return () =>
        send(
          busy && gate.installing
            ? { kind: 'answer', id: request.id, ok: false, error: 'An update is installing.' }
            : { kind: 'answer', id: request.id, ok: true, value: null },
        )
    }
    const params = request.params as { account: string; secret?: string }
    const value =
      request.method === 'keychain.get'
        ? { secret: keychain.get(params.account) ?? null }
        : request.method === 'keychain.set'
          ? (keychain.set(params.account, params.secret ?? ''), null)
          : request.method === 'keychain.delete'
            ? (keychain.delete(params.account), null)
            : undefined
    return () =>
      send(
        value === undefined
          ? { kind: 'answer', id: request.id, ok: false, error: `no ${String(request.method)} here` }
          : { kind: 'answer', id: request.id, ok: true, value },
      )
  }

  // Every line the sidecar writes, but its requests, waits here until a test reads it. `undefined` marks the end.
  const inbox: (Message | undefined)[] = []
  let wake: (() => void) | undefined
  void (async () => {
    let buffered = ''
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buffered += chunk
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const message = JSON.parse(buffered.slice(0, end)) as Message
        buffered = buffered.slice(end + 1)
        if (message.kind === 'request') {
          const reply = answer(message)
          if (options.hold === undefined) reply()
          else options.hold(message, reply)
        }
        else inbox.push(message)
      }
      wake?.()
    }
    inbox.push(undefined)
    wake?.()
  })()
  let errors = ''
  const stderrDone = (async () => {
    for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) errors += chunk
  })()

  /** The next message, waiting for it when there is none yet. */
  async function take(): Promise<Message | undefined> {
    while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve))
    const message = inbox.shift()
    if (message === undefined) inbox.unshift(undefined)
    return message
  }

  /** Messages a call read past while it waited for its reply, in order, for `next`. */
  const skipped: Message[] = []
  const next = async () => skipped.shift() ?? (await take())
  let calls = 0
  /** Calls one method and returns its value, or throws its error. */
  const call = async (method: string, params: unknown = {}) => {
    const id = ++calls
    send({ kind: 'call', id, method, params })
    for (;;) {
      const message = await take()
      if (message === undefined) throw new Error(`the sidecar ended before it answered ${method}`)
      if (message.kind !== 'reply' || message.id !== id) {
        skipped.push(message)
        continue
      }
      if (message.ok !== true) throw new Error(String(message.error))
      return message.value
    }
  }
  /** Reads events until one matches, or fails after `ms`. */
  const until = async (match: (event: Message) => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const message = await Promise.race([next(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => 'timeout' as const)])
      if (message === 'timeout') throw new Error('no matching event in time')
      if (message === undefined) throw new Error('the sidecar ended first')
      if (message.kind === 'event' && match(message.event as Message)) return message.event as Message
    }
  }
  const quit = async () => {
    child.stdin.end()
    return child.exited
  }
  /** Everything the sidecar logged, once it has exited. */
  const stderr = async () => {
    await child.exited
    await stderrDone
    return errors
  }
  return { child, next, send, call, until, quit, stderr, gate }
}
