/** The sidecar as Rust runs it: a child process spoken to over stdin and stdout, one JSON object per line. */
export function spawnSidecar(dataDir: string, projectsDir: string) {
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
        yield JSON.parse(buffered.slice(0, end)) as Record<string, unknown>
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf('\n')
      }
    }
  })()
  const next = async () => (await lines.next()).value
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  let calls = 0
  /** Calls one method and returns its value, or throws its error. */
  const call = async (method: string, params: unknown = {}) => {
    const id = ++calls
    send({ kind: 'call', id, method, params })
    for (;;) {
      const message = await next()
      if (message === undefined) throw new Error(`the sidecar ended before it answered ${method}`)
      if (message.kind !== 'reply' || message.id !== id) continue
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
