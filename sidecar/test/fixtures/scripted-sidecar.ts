/**
 * The sidecar with a scripted model beside the app's providers, for tests: provider `faux`, models `faux-a` and
 * `faux-b`. `M3D_SCRIPT` picks the script. Each answer depends only on the transcript, so a sidecar that restarts
 * mid-turn goes on with the same script.
 */
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
    faux.setResponses(Array.from({ length: 200 }, () => (context, _options, _state, model) => script(context.messages, model)))
    models.setProvider(faux.provider)
  },
})
