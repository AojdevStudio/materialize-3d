/**
 * The sidecar with a scripted model beside the app's providers, for tests: provider `faux`, models `faux-a` and
 * `faux-b`. `M3D_SCRIPT` picks the script. Each answer depends only on the transcript, so a sidecar that restarts
 * mid-turn goes on with the same script. OpenAI Codex, Astra's provider, is replaced by a scripted Astra that answers
 * only once a key is saved for it, as the real one answers only once the person signs in.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message, type Model } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { runSidecar } from '../../src/app'

/** The messages since the person's newest message, and that message's text. */
function sinceUser(messages: Message[]) {
  const at = messages.findLastIndex((m) => m.role === 'user')
  const user = messages[at]
  const text = user === undefined ? '' : typeof user.content === 'string' ? user.content : user.content.map((b) => ('text' in b ? b.text : '')).join('')
  return { text, results: messages.slice(at + 1).filter((m) => m.role === 'toolResult') }
}

/** A step that calls one tool. Its stop reason tells Pi the model waits for the result. */
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
const run = (script: string) => call('run', { args: ['run', 'sh', '-c', script] })
const resultText = (message: Message | undefined) =>
  message?.role === 'toolResult' ? message.content.map((b) => ('text' in b ? b.text : '')).join('') : ''

const scripts: Record<string, (messages: Message[], model: Model<string>) => AssistantMessage> = {
  /** Two outside actions, then an answer. The second waits for a `go` file, so a test can crash the sidecar in it. */
  ops: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return run('echo op1 >> ops.log')
    if (results.length === 1) return run('echo op2 >> ops.log; while [ ! -f go ]; do sleep 0.05; done')
    return fauxAssistantMessage(fauxText('done'))
  },
  /** A message with "wait" runs a tool that waits for `go`; every answer names the model that gave it. */
  models: (messages, model) => {
    const { text, results } = sinceUser(messages)
    if (text.includes('wait') && results.length === 0) return run('touch started; while [ ! -f go ]; do sleep 0.05; done')
    return fauxAssistantMessage(fauxText(`answered by ${model.id}`))
  },
  /**
   * Says what the model was given: how many pictures the newest message holds, and the text of every message the person
   * sent in this chat, so a test can see a path still reaches the model in a later turn.
   */
  attachments: (messages) => {
    const users = messages.filter((m) => m.role === 'user')
    const newest = users.at(-1)?.content
    const pictures = typeof newest === 'string' || newest === undefined ? 0 : newest.filter((b) => b.type === 'image').length
    const texts = users.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => ('text' in b ? b.text : '')).join('')))
    return fauxAssistantMessage(fauxText(`pictures=${pictures} | ${texts.join(' || ')}`))
  },
  /** Hands Astra a task, then repeats what Astra answered. */
  astra: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return call('astra', { task: 'Draw it as an HTML page.' })
    return fauxAssistantMessage(fauxText(`parent saw: ${resultText(results[0])}`))
  },
  /** Reads a file and hands Astra a task in the same step, then repeats what Astra answered. */
  'astra-and-read': (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) {
      return fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' }), fauxToolCall('astra', { task: 'Draw it as an HTML page.' })], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage(fauxText('both done'))
  },
  /** Shows the command's environment: whether the sidecar's own variables reach it, and its operation id. */
  env: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return run('echo "secret=${M3D_SECRET:-none} op=${M3D_OPERATION_ID:+set}"')
    return fauxAssistantMessage(fauxText(resultText(results[0])))
  },
  /** A command that marks its start, then runs for three seconds, long enough for a test to kill the sidecar first. */
  orphan: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return run('touch started; sleep 3; touch finished')
    return fauxAssistantMessage(fauxText('ran'))
  },
  /**
   * A command that ends a moment after it starts, so a sidecar killed at its start restarts while it still runs. It
   * prints its result after that kill.
   */
  quick: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return run('touch started; sleep 0.5; echo ran >> ran.log; echo measured-value=42')
    return fauxAssistantMessage(fauxText('ran'))
  },
  /** A command that runs past its one-second timeout. */
  slow: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return call('run', { args: ['run', 'sh', '-c', 'sleep 3; touch finished'], timeoutSeconds: 1 })
    return fauxAssistantMessage(fauxText('timed'))
  },
  /** Reads, writes, and edits through `linked`, which a test points outside the project. */
  linked: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return call('read', { path: 'linked/secret.txt' })
    if (results.length === 1) return call('write', { path: 'linked/new.txt', content: 'x' })
    if (results.length === 2) return call('edit', { path: 'linked/secret.txt', edits: [{ oldText: 'secret', newText: 'leaked' }] })
    if (results.length === 3) return call('write', { path: 'dangling', content: 'x' })
    if (results.length === 4) return call('write', { path: 'climb', content: 'x' })
    return fauxAssistantMessage(fauxText('tried'))
  },
  /** A tool that waits for `go`, then a model request that fails. */
  'fails-after': (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return run('touch started; while [ ! -f go ]; do sleep 0.05; done')
    return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'the model broke' })
  },
  /** Slices one part, then repeats what the tool said. */
  slice: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return call('slice', { inputs: ['cube.stl'], output: 'print/cube.3mf' })
    return fauxAssistantMessage(fauxText(resultText(results[0])))
  },
  /** Tries to read a file outside the project folder, then reports what the tool said. */
  escape: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return call('read', { path: '/etc/hostname' })
    return fauxAssistantMessage(fauxText('tried'))
  },
}

const script = scripts[process.env.M3D_SCRIPT ?? '']
if (script === undefined) throw new Error(`M3D_SCRIPT must be one of ${Object.keys(scripts).join(', ')}`)

await runSidecar({
  argv: process.argv.slice(2),
  addProviders: (models) => {
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-a' }, { id: 'faux-b' }] })
    // Every script answers `make the project` with `made`, so a test can make a project before its first real message.
    faux.setResponses(
      Array.from({ length: 200 }, () => (context, _options, _state, model) =>
        sinceUser(context.messages).text === 'make the project' ? fauxAssistantMessage(fauxText('made')) : script(context.messages, model),
      ),
    )
    models.setProvider(faux.provider)
    const astra = fauxProvider({ provider: 'openai-codex', models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] })
    // Astra runs a command of its own first, in the project folder it shares. The provider refuses the key `refused`,
    // and with M3D_ASTRA_GATE set, it holds that request open until the test writes `release` there.
    const gate = process.env.M3D_ASTRA_GATE
    astra.setResponses(
      Array.from({ length: 50 }, () => async (context, options) => {
        if (options?.apiKey === 'refused') {
          if (gate !== undefined) {
            writeFileSync(join(gate, 'asked'), '')
            while (!existsSync(join(gate, 'release'))) await Bun.sleep(25)
          }
          return fauxAssistantMessage([], { stopReason: 'error', errorMessage: '401 Unauthorized: invalid token' })
        }
        return sinceUser(context.messages).results.length === 0 ? run('echo astra-ran > astra.txt') : fauxAssistantMessage(fauxText('astra drew it'))
      }),
    )
    models.setProvider({
      ...astra.provider,
      auth: { apiKey: { name: 'Astra test key', resolve: async ({ credential }) => (credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } }) } },
    })
  },
})
