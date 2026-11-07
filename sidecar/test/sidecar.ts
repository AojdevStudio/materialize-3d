/**
 * The sidecar as Rust runs it: a child process spoken to over stdin and stdout, one JSON object per line. The test
 * plays Rust: it answers the sidecar's Keychain requests from `keychain`, which stands in for the macOS Keychain.
 */
export function spawnSidecar(dataDir: string, projectsDir: string, keychain = new Map<string, string>()) {
  const child = Bun.spawn(['bun', 'src/main.ts', '--app-version', '9.9.9', '--data', dataDir, '--projects', projectsDir], {
    cwd: `${import.meta.dir}/..`,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const lines = (async function* () {
    let buffered = ''
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buffered += chunk
      let end = buffered.indexOf('\n')
      while (end >= 0) {
        const message = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf('\n')
        if (message.kind === 'request') answer(message)
        else yield message
      }
    }
  })()
  function answer(request: Record<string, unknown>) {
    const params = request.params as { account: string; secret?: string }
    const value =
      request.method === 'keychain.get'
        ? { secret: keychain.get(params.account) ?? null }
        : request.method === 'keychain.set'
          ? (keychain.set(params.account, params.secret ?? ''), null)
          : request.method === 'keychain.delete'
            ? (keychain.delete(params.account), null)
            : undefined
    send(value === undefined ? { kind: 'answer', id: request.id, ok: false, error: `no ${String(request.method)} here` } : { kind: 'answer', id: request.id, ok: true, value })
  }
  /** Messages a call read past while it waited for its reply, in order, for `next`. */
  const skipped: Record<string, unknown>[] = []
  const next = async () => skipped.shift() ?? (await lines.next()).value
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  let calls = 0
  /** Calls one method and returns its value, or throws its error. */
  const call = async (method: string, params: unknown = {}) => {
    const id = ++calls
    send({ kind: 'call', id, method, params })
    for (;;) {
      const message = (await lines.next()).value
      if (message === undefined) throw new Error(`the sidecar ended before it answered ${method}`)
      if (message.kind !== 'reply' || message.id !== id) {
        skipped.push(message)
        continue
      }
      if (message.ok !== true) throw new Error(String(message.error))
      return message.value
    }
  }
  const quit = async () => {
    child.stdin.end()
    return child.exited
  }
  return { child, next, send, call, quit }
}
