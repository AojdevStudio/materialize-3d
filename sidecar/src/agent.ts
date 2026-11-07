/**
 * The agent's own tools, and nothing of the person's agent setup. The file tools work in the project folder only.
 *
 * Tools that act outside the store (`run`, `slice`) are replay-safe and keep a receipt per operation, under a stable
 * operation id (the tool call's id). The action writes its receipt file the moment it ends, and the call records it in
 * Pi before it returns, so a rerun after a crash hands back the result instead of acting again. A crash between the
 * end of an action and its receipt file still repeats that one action, because no checkpoint can make an outside
 * action run exactly once. `run` passes the id on as `M3D_OPERATION_ID`, for a script that wants to check for itself.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
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
import { isLoginFailure } from './inference'
import { textOf } from './transcript'
import workflow from './workflow.md' with { type: 'text' }

/** The instructions every turn runs with, and the version a turn records. */
export const WORKFLOW = workflow
export const WORKFLOW_VERSION = createHash('sha256').update(workflow).digest('hex').slice(0, 12)

/** Astra, the GPT helper: OpenAI's model on the person's ChatGPT plan. */
export const ASTRA_MODEL = { provider: 'openai-codex', modelId: 'gpt-6-astra' } as const

/** How much of a command's output the model gets back: the end, where errors are. */
const OUTPUT_TAIL = 20_000

/** The only variables a command the agent runs gets. */
const COMMAND_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const

/**
 * Where `path` really is: the real path of its nearest folder that exists, with the rest of the path after it. A
 * symbolic link on the way is followed, so a path that leads out of the project through one is seen to.
 */
function realPath(path: string): string {
  const rest: string[] = []
  let at = path
  while (!existsSync(at)) {
    rest.unshift(basename(at))
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return join(realpathSync(at), ...rest)
}

/** One project's files and processes. A path that leads out of the project folder is refused, for every file tool. */
export class ProjectEnv extends NodeExecutionEnv {
  override async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = await super.absolutePath(path, context)
    if (!resolved.ok) return resolved
    const inside = relative(realpathSync(this.cwd), realPath(resolved.value))
    if (inside.startsWith('..') || isAbsolute(inside)) {
      return err(new FileError('permission_denied', `${path} is outside the project folder`, path))
    }
    return resolved
  }
}

/** Pi's record of one operation's result, kept by its tool call. */
export interface Memo<T> {
  get(): Promise<T | undefined>
  set(value: T): Promise<T>
}

/**
 * The result of one outside action, done once per operation: the result Pi kept, else the receipt file the action
 * left when it ended, else the action itself, whose receipt file is written the moment it ends.
 */
export async function once<T extends JsonValue>(memo: Memo<T>, receipt: string, act: () => Promise<T>): Promise<T> {
  const kept = await memo.get()
  if (kept !== undefined) return kept
  if (existsSync(receipt)) return memo.set(JSON.parse(readFileSync(receipt, 'utf8')) as T)
  const result = await act()
  mkdirSync(dirname(receipt), { recursive: true })
  writeFileSync(`${receipt}.new`, JSON.stringify(result))
  renameSync(`${receipt}.new`, receipt)
  return memo.set(result)
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

export interface AgentHost {
  host: Host
  /** The project a conversation belongs to, and its folder. */
  projectOf(conversation: number): Promise<{ id: string; folder: string }>
  /** Holds a tool until the person signs in to `provider`, with the fix named on the chat. A stop ends the wait. */
  waitForLogin(conversation: number, provider: string, context: Context): Promise<void>
}

/** A tool call's operation: its id, its receipt file in the project's hidden folder, and Pi's memo of it. */
async function operation<T extends JsonValue>(api: ToolExecutionApi, context: Context, projectOf: AgentHost['projectOf']) {
  const project = await projectOf(api.conversationId)
  const id = api.callId.replace(/[^A-Za-z0-9_-]/g, '_')
  const memo: Memo<T> = { get: () => api.memo<T>('receipt', context), set: (value) => api.memo('receipt', value, context) }
  return { id, project, memo, receipt: join(project.folder, '.m3d', 'ops', `${id}.json`) }
}

/** The agent's tools, in the order the model is offered them. */
export function agentTools({ host, projectOf, waitForLogin }: AgentHost) {
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
      const op = await operation<{ exitCode: number; output: string }>(api, context, projectOf)
      const vars: Record<string, string> = { M3D_OPERATION_ID: op.id }
      for (const name of COMMAND_ENV) {
        const value = process.env[name]
        if (value !== undefined) vars[name] = value
      }
      const receipt = await once(op.memo, op.receipt, async () => {
        let output = ''
        const ran = await env.exec(
          ['uv', ...args],
          {
            env: vars,
            inheritEnv: false,
            timeout: timeoutSeconds ?? 600,
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
      type Sliced = { ok: true; parts: number; printSeconds: number; filamentGrams: number } | { ok: false; error: string }
      const op = await operation<Sliced>(api, context, projectOf)
      const sliced = await once<Sliced>(op.memo, op.receipt, async () => {
        try {
          const { parts, printSeconds, filamentGrams } = await host.request('slice', { project: op.project.id, inputs, output })
          return { ok: true, parts, printSeconds, filamentGrams }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
      if (!sliced.ok) return { output: text(`The slice failed: ${sliced.error}`), isError: true }
      const minutes = Math.round(sliced.printSeconds / 60)
      return { output: text(`Wrote ${output}: ${sliced.parts} part(s), about ${minutes} min and ${sliced.filamentGrams.toFixed(1)} g of filament.`) }
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
      const signedIn = async () => (await api.models.getAuth(ASTRA_MODEL.provider).catch(() => undefined)) !== undefined
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
      // Astra runs on the person's ChatGPT sign-in. Without it the turn waits here, with the fix named, and goes on.
      if (!(await signedIn())) await waitForLogin(api.conversationId, ASTRA_MODEL.provider, context)
      let submission = await conversation.submit({ type: 'input', content: task, requestId: `astra:${api.taskId}` }, context)
      for (;;) {
        const settled = await submission.wait(context)
        if (settled.status === 'done' && settled.type !== 'write') {
          const { answer } = settled
          const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context)
          return { output: text(textOf(entry?.model?.[0]?.content) || 'Astra finished without a message.') }
        }
        const detail = typeof settled.detail === 'string' ? settled.detail : ''
        if (settled.reason !== 'model_error' || !(isLoginFailure(detail) || !(await signedIn()))) {
          return { output: text(`Astra did not answer (${settled.reason}${detail === '' ? '' : `: ${detail}`}).`), isError: true }
        }
        // The sign-in was missing or refused: wait for it, then Astra goes on from where it stopped.
        await waitForLogin(api.conversationId, ASTRA_MODEL.provider, context)
        submission = await conversation.submit({ type: 'continue' }, context)
      }
    },
  })

  return [read, write, edit, run, slice, astra] as const satisfies readonly ToolRegistration[]
}

/** The one extension the app installs. Nothing else is registered, so the agent has these tools and no others. */
export function agentExtension(tools: readonly ToolRegistration[]) {
  return defineExtension({ name: 'materialize', tools })
}
