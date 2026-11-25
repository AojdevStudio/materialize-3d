/**
 * The sidecar with scripted models beside the app's providers, for tests: provider `faux`, models `faux-a` and
 * `faux-b`, and OpenAI Codex, replaced by scripted models that answer only once a key is saved for it, as the real one
 * answers only once the person signs in. `M3D_SCRIPT` picks the lead's script. Every model plays either role: a
 * request whose newest message is one of the helper tasks below gets that task's helper answer. Each answer depends
 * only on the transcript, so a sidecar that restarts mid-turn goes on with the same script.
 *
 * Per request, before any script: a model listed in `M3D_RETIRED` (a comma list) answers as a provider that removed
 * it, and with `M3D_FLAKY` set, each model's first request answers that the provider is overloaded.
 *
 * The app's catalog gains `gpt-6.3-sol`, a newer Sol version than the app ships. `M3D_MOBILE_PORT` and
 * `M3D_PAIRING_TTL_MS` set the phone service's port and how long a pairing code works. `M3D_READ_GATE` lets a test
 * hold a read, as `holdReads` says.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AssistantMessage, type Context, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message, type Model } from '@earendil-works/pi-ai'
import { type JsonObject, LiveDoc } from '@earendil-works/pi-durable'
import { runSidecar } from '../../src/app'
import { CATALOG, type Catalog } from '../../src/offered'
import { Store } from '../../src/store'

/** The task a helper draws for: it writes its model id to `helper.txt`, then says it drew it. */
export const DRAW = 'Draw it as an HTML page.'
/** The task a helper tries to hand on with its own `helper` call, then repeats what that call gave it. */
export const HAND_ON = 'Hand this on.'
/** The task a helper fails, with an error that is neither a missing login nor a retired model. */
export const FAIL = 'Fail.'
/** The task a helper takes two steps on: the first waits for a `next` file, the second for `go`. Then it says it waited. */
export const STEPS = 'Take two steps.'
/** `STEPS` with its own files, `nextB` and `goB`, for a second helper beside the first. */
export const STEPS_B = 'Take two steps beside.'

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
  /**
   * Two outside actions, then an answer. The second writes its process id, then waits for a `go` file, so a test can
   * crash the sidecar in it and wait for it to end.
   */
  ops: (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return run('echo op1 >> ops.log')
    if (results.length === 1) return run('echo $$ > op2.pid; echo op2 >> ops.log; while [ ! -f go ]; do sleep 0.05; done')
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
  /**
   * Hands the helper a task, then repeats what the helper answered. The task is what follows `ask: ` in the person's
   * message, or `DRAW`.
   */
  helper: (messages) => {
    const { text, results } = sinceUser(messages)
    if (results.length === 0) return call('helper', { task: text.startsWith('ask: ') ? text.slice('ask: '.length) : DRAW })
    return fauxAssistantMessage(fauxText(`parent saw: ${resultText(results[0])}`))
  },
  /** Hands two helpers `STEPS` and `STEPS_B` in one step, so they run at once, then says both were done. */
  'two-helpers': (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) {
      return fauxAssistantMessage([fauxToolCall('helper', { task: STEPS }), fauxToolCall('helper', { task: STEPS_B })], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage(fauxText('both waited'))
  },
  /** Runs a command that waits for `go`, then hands the helper `DRAW`, then repeats what the helper answered. */
  'wait-then-helper': (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) return run('touch started; while [ ! -f go ]; do sleep 0.05; done')
    if (results.length === 1) return call('helper', { task: DRAW })
    return fauxAssistantMessage(fauxText(`parent saw: ${resultText(results[1])}`))
  },
  /** Reads a file and hands the helper a task in the same step, then repeats what the helper answered. */
  'helper-and-read': (messages) => {
    const { results } = sinceUser(messages)
    if (results.length === 0) {
      return fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' }), fauxToolCall('helper', { task: DRAW })], { stopReason: 'toolUse' })
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

const fails = (errorMessage: string) => fauxAssistantMessage([], { stopReason: 'error', errorMessage })
const retired = new Set((process.env.M3D_RETIRED ?? '').split(',').filter((id) => id !== ''))
const flaky = process.env.M3D_FLAKY !== undefined
/** The models that already had their first request, which `M3D_FLAKY` fails. */
const asked = new Set<string>()

/** Any model's answer, in either role. */
const answer = (context: Context, model: Model<string>): AssistantMessage => {
  if (retired.has(model.id)) return fails(`404 model_not_found: The model '${model.id}' has been deprecated`)
  if (flaky && !asked.has(model.id)) {
    asked.add(model.id)
    return fails('529 overloaded_error: Overloaded')
  }
  const { text, results } = sinceUser(context.messages)
  // Every script answers `make the project` with `made`, so a test can make a project before its first real message.
  if (text === 'make the project') return fauxAssistantMessage(fauxText('made'))
  if (text === DRAW) return results.length === 0 ? run(`echo ${model.id} > helper.txt`) : fauxAssistantMessage(fauxText(`${model.id} drew it`))
  if (text === HAND_ON) return results.length === 0 ? call('helper', { task: DRAW }) : fauxAssistantMessage(fauxText(`child saw: ${resultText(results[0])}`))
  // Pi retries a provider's temporary failures, such as a 500, by itself. This one it does not.
  if (text === FAIL) return fails('400 invalid_request_error: the helper could not do this task')
  if (text === STEPS) {
    if (results.length === 0) return run('touch first; while [ ! -f next ]; do sleep 0.05; done')
    if (results.length === 1) return run('touch second; while [ ! -f go ]; do sleep 0.05; done')
    return fauxAssistantMessage(fauxText('waited'))
  }
  if (text === STEPS_B) {
    if (results.length === 0) return run('touch firstB; while [ ! -f nextB ]; do sleep 0.05; done')
    if (results.length === 1) return run('touch secondB; while [ ! -f goB ]; do sleep 0.05; done')
    return fauxAssistantMessage(fauxText('waited beside'))
  }
  return script(context.messages, model)
}

/** The app's catalog with a newer Sol version first, served by the scripted OpenAI Codex. */
const catalog: Catalog = {
  ...CATALOG,
  families: CATALOG.families.map((family) => (family.name === 'GPT Sol' ? { ...family, versions: [{ modelId: 'gpt-6.3-sol', name: 'GPT 6.3 Sol' }, ...family.versions] } : family)),
}

/**
 * Lets a test hold a chat's reads made on their own, not beside a read of the chat's live state, as a chat read does:
 * a helper call's read of its turn as it starts (`turn`), and a chat read's look at its waiting state once it took its
 * place in the order of reads (`waiting`). Once the test writes `hold-<doc>` in folder `gate`, the read of that doc
 * after as many as the file says goes through, then writes `held-<doc>` and waits for `release-<doc>`.
 */
function holdReads(gate: string) {
  const open = Store.open.bind(Store)
  Store.open = async (options) => {
    const store = await open(options)
    const { harness } = store
    const snapshot = harness.snapshot.bind(harness)
    let beside = false
    const passed = new Map<string, number>()
    harness.snapshot = (async (...args: Parameters<typeof snapshot>) => {
      const [doc] = args
      if (doc.definition.kind === LiveDoc.definition.kind) {
        beside = true
        queueMicrotask(() => (beside = false))
      }
      const name = new Map([['m3d.turn', 'turn'], ['m3d.waiting', 'waiting']]).get(doc.definition.kind)
      const hold = join(gate, `hold-${name}`)
      if (name !== undefined && !beside && existsSync(hold)) {
        const through = passed.get(name) ?? 0
        if (through < Number(readFileSync(hold, 'utf8') || '0')) passed.set(name, through + 1)
        else {
          unlinkSync(hold)
          passed.delete(name)
          writeFileSync(join(gate, `held-${name}`), '')
          while (!existsSync(join(gate, `release-${name}`))) await Bun.sleep(25)
        }
      }
      return snapshot(...args)
    }) as typeof snapshot
    return store
  }
}
if (process.env.M3D_READ_GATE !== undefined) holdReads(process.env.M3D_READ_GATE)

const mobilePort = process.env.M3D_MOBILE_PORT
const pairingTtl = process.env.M3D_PAIRING_TTL_MS

await runSidecar({
  argv: process.argv.slice(2),
  catalog,
  ...(mobilePort === undefined ? {} : { mobilePort: Number(mobilePort) }),
  ...(pairingTtl === undefined ? {} : { pairingTtlMs: Number(pairingTtl) }),
  addProviders: (models) => {
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-a' }, { id: 'faux-b' }] })
    faux.setResponses(Array.from({ length: 200 }, () => (context, _options, _state, model) => answer(context, model)))
    models.setProvider(faux.provider)
    const codex = fauxProvider({ provider: 'openai-codex', models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6.3-sol' }] })
    // The provider refuses the key `refused`, and with M3D_ASTRA_GATE set, it holds that request open until the test
    // writes `release` there.
    const gate = process.env.M3D_ASTRA_GATE
    codex.setResponses(
      Array.from({ length: 200 }, () => async (context, options, _state, model) => {
        if (options?.apiKey === 'refused') {
          if (gate !== undefined) {
            writeFileSync(join(gate, 'asked'), '')
            while (!existsSync(join(gate, 'release'))) await Bun.sleep(25)
          }
          return fails('401 Unauthorized: invalid token')
        }
        return answer(context, model)
      }),
    )
    models.setProvider({
      ...codex.provider,
      auth: { apiKey: { name: 'OpenAI Codex test key', resolve: async ({ credential }) => (credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } }) } },
    })
  },
})
