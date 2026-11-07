/**
 * The agent's own tools, and nothing of the person's agent setup. Every tool works in the project folder only.
 *
 * Tools that act outside the store (`run`, `slice`, `astra`) are replay-safe and keep a receipt: a call that finished
 * its action records the result before it returns, so a rerun after a crash hands back the receipt instead of acting
 * again. A crash between the action and its receipt still repeats that one action, because no checkpoint can make an
 * outside action run exactly once.
 */
import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { Context, JsonValue } from '@earendil-works/chord'
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  type ToolExecutionApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { err, FileError, type Result } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { arr, int, obj, opt, str } from '@earendil-works/pi-schema'
import type { Host } from './host'
import { textOf } from './transcript'
import workflow from './workflow.md' with { type: 'text' }

/** The instructions every turn runs with, and the version a turn records. */
export const WORKFLOW = workflow
export const WORKFLOW_VERSION = createHash('sha256').update(workflow).digest('hex').slice(0, 12)

/** Astra, the GPT helper: OpenAI's model on the person's ChatGPT plan. */
export const ASTRA_MODEL = { provider: 'openai-codex', modelId: 'gpt-6-astra' } as const

/** How much of a command's output the model gets back: the end, where errors are. */
const OUTPUT_TAIL = 20_000

/** One project's files and processes. Any path that leaves the project folder is refused, for every file tool. */
export class ProjectEnv extends NodeExecutionEnv {
  override async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = await super.absolutePath(path, context)
    if (!resolved.ok) return resolved
    const inside = relative(this.cwd, resolved.value)
    if (inside.startsWith('..') || isAbsolute(inside)) {
      return err(new FileError('permission_denied', `${path} is outside the project folder`, path))
    }
    return resolved
  }
}

/** Does `act` once for this tool call. A rerun after a crash gets the first run's receipt back. */
async function once<T extends JsonValue>(api: ToolExecutionApi, context: Context, act: () => Promise<T>): Promise<T> {
  const receipt = await api.memo<T>('receipt', context)
  if (receipt !== undefined) return receipt
  return api.memo('receipt', await act(), context)
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

export interface AgentHost {
  host: Host
  /** The project a conversation belongs to. */
  projectOf(conversation: number): Promise<string>
}

/** The agent's tools, in the order the model is offered them. */
export function agentTools({ host, projectOf }: AgentHost) {
  const read = createReadTool()
  const write = { ...createWriteTool(), replay: 'safe' as const }
  const edit = createEditTool()

  const run = defineTool({
    name: 'run',
    description:
      'Run uv in the project folder, for the build and check scripts. Pass the arguments after `uv`, for example ' +
      '["run", "--with", "manifold3d", "--with", "numpy", "python", "build/model.py"]. Returns the exit code and the end of the output.',
    parameters: obj({ args: arr(str(), { minItems: 1 }), timeoutSeconds: opt(int({ minimum: 1, maximum: 3600 })) }),
    replay: 'safe',
    execute: async ({ args, timeoutSeconds }, api, context) => {
      const env = api.env
      if (env === undefined) throw new Error('this conversation has no project folder')
      const receipt = await once(api, context, async () => {
        let output = ''
        const ran = await env.exec(
          ['uv', ...args],
          {
            timeout: (timeoutSeconds ?? 600) * 1000,
            onOutput: (chunk) => {
              output = (output + chunk).slice(-OUTPUT_TAIL)
              api.output(chunk)
            },
          },
          context,
        )
        return ran.ok ? { exitCode: ran.value.exitCode, output } : { exitCode: -1, output: `${output}\n${ran.error.message}` }
      })
      return { output: text(`exit code ${receipt.exitCode}\n${receipt.output}`), isError: receipt.exitCode !== 0 }
    },
  })

  const slice = defineTool({
    name: 'slice',
    description:
      'Slice STL files in the project folder to one print-ready 3MF for the Bambu Lab P2S (0.4 mm nozzle, 0.20 mm layers, ' +
      'PETG) with the validated Bambu Studio. Paths are relative to the project folder; the output ends in .3mf.',
    parameters: obj({ inputs: arr(str(), { minItems: 1 }), output: str() }),
    replay: 'safe',
    execute: async ({ inputs, output }, api, context) => {
      const project = await projectOf(api.conversationId)
      const sliced = await once(api, context, async () => {
        try {
          return { ok: true, ...(await host.request('slice', { project, inputs, output })) }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
      if (!sliced.ok) return { output: text(`The slice failed: ${sliced.error}`), isError: true }
      const minutes = Math.round(Number(sliced.printSeconds) / 60)
      return { output: text(`Wrote ${output}: ${sliced.parts} part(s), about ${minutes} min and ${Number(sliced.filamentGrams).toFixed(1)} g of filament.`) }
    },
  })

  const astra = defineTool({
    name: 'astra',
    description:
      'Hand a task to Astra, the GPT helper, who works in this project folder with the same file tools and `run`. ' +
      'Astra cannot see this chat, so say everything: what to do, the files to read, and the file to write.',
    parameters: obj({ task: str({ minLength: 1 }) }),
    replay: 'safe',
    execute: async ({ task }, api, context) => {
      // Astra's conversation is owned by this call, so a rerun finds the same one and the same request.
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
        if (existing !== undefined) return existing.id
        const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
        await configure(tx, created.id, { model: ASTRA_MODEL, tools: [read, write, edit, run] })
        return created.id
      }, context)
      await api.details({ astra: child }, context)
      const conversation = await api.conversation(child, context)
      if (conversation === undefined) throw new Error("Astra's conversation is gone")
      const submission = await conversation.submit({ type: 'input', content: task, requestId: `astra:${api.taskId}` }, context)
      const settled = await submission.wait(context)
      if (settled.status !== 'done' || settled.type !== 'input') {
        const why = settled.status === 'unanswered' ? `${settled.reason}${settled.detail === undefined ? '' : `: ${settled.detail}`}` : settled.status
        return { output: text(`Astra did not answer (${why}).`), isError: true }
      }
      const { answer } = settled
      const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context)
      return { output: text(textOf(entry?.model?.[0]?.content) || 'Astra finished without a message.') }
    },
  })

  return [read, write, edit, run, slice, astra] as const satisfies readonly ToolRegistration[]
}

/** The one extension the app installs. Nothing else is registered, so the agent has these tools and no others. */
export function agentExtension(tools: readonly ToolRegistration[]) {
  return defineExtension({ name: 'materialize', tools })
}
