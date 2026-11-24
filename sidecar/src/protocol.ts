/**
 * The pipe between the Rust core and the sidecar: one JSON object per line, each way.
 *
 * The window calls the sidecar through Rust (`invoke('sidecar')`) and hears it on one event. The sidecar asks
 * Rust for what only Rust can do: the Keychain and the Bambu slice step. This file imports nothing, so the
 * window's code can share its types and lists. Each value list is defined once here, and the sidecar builds its param
 * schemas from it.
 */

export type ModelChoice = { provider: string; modelId: string }

/** The two parts a model plays in a chat: the lead answers the person, and the helper takes tasks the lead hands it. */
export type Role = 'lead' | 'helper'

/**
 * A model version a provider reported removed while a chat ran it, the role it held there, and the newest version of its
 * family, or null when that is the removed one.
 */
export type Retired = { role: Role; model: ModelChoice; replacement: ModelChoice | null }

/** A model the picker offers, with the short name the app shows and one line on what it suits. */
export type ModelOption = ModelChoice & { name: string; description: string }

export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Thinking = (typeof THINKING)[number]

export const SETUP_STEPS = ['welcome', 'check', 'model', 'printer', 'ready'] as const

/** Where first-launch setup stands. Setup reopens on `step` until it is `done`. */
export type Setup = { step: (typeof SETUP_STEPS)[number]; done: boolean }

/** The build plates, by the names Bambu Studio's `curr_bed_type` setting takes. */
export const PLATES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Supertack Plate'] as const
export type Plate = (typeof PLATES)[number]

/**
 * The printer a slice runs for: three Bambu Lab system presets by the names Bambu Studio gives them, and the plate.
 * With no plate, a slice uses the default plate of the printer's model.
 */
export type Printer = { machine: string; process: string; filament: string; plate?: Plate }

/**
 * What the next turn starts with. A running turn keeps the model and thinking it started with. Each slice reads the
 * printer when it starts. `model` is the lead a chat made on the start screen gets. `astra` gives such a chat the
 * newest Astra as its helper, when Astra can run.
 */
export type Settings = {
  model: ModelChoice
  thinking: Thinking
  printer: Printer
  astra: boolean
}

/**
 * `conversation` is the project's Pi conversation id. `printed` is set once the person marks the project printed.
 * `model` is the lead model the project's next turn runs on, and `helper` the helper model that turn can hand tasks to,
 * or null when the lead works alone. A project gets the start screen's pair when it is made. A project from before
 * pairs gets the lead it ran on and the helper the Astra setting gave it. `retired` holds each role whose version a
 * provider reported removed in this chat, until the person chooses that role again.
 */
export type Project = {
  id: string
  conversation: number
  title: string
  createdMs: number
  printed?: boolean
  model: ModelChoice
  helper: ModelChoice | null
  retired?: Retired[]
}

/**
 * What the sidebar groups a project by. `printFiles` counts the `.3mf` files in its folder, outside `refs/`. `lastMs` is
 * its last activity: when it was made, when its last turn started, or when a file in its folder last changed.
 */
export type ProjectStatus = { running: boolean; printed: boolean; printFiles: number; lastMs: number }

/** The draft key of the start screen, whose message has no project yet. Every other draft is keyed by its project id. */
export const START = 'new'

/**
 * An unsent message, by project id, or `START` for the start screen. Attachments are the paths of its files where they
 * are now: a picked or dropped file of any kind, or a pasted picture the sidecar keeps. A send copies them into the
 * project's `refs/` folder.
 */
export type Draft = { text: string; attachments: string[] }

/**
 * A draft as the store keeps it. `rev` grows with every save of any draft, and is never used again, so a send can name
 * the draft it went out with, and a newer one saved meanwhile is never taken for it.
 */
export type SavedDraft = Draft & { rev: number }

/** How a provider's login was made: an API key or proxy token, or a subscription sign-in. */
export type LoginKind = 'api_key' | 'oauth'

/** The providers the app signs in to, in the order the app lists them. */
export const PROVIDERS = ['anthropic', 'openai-codex', 'opencode-go'] as const
export type ProviderId = (typeof PROVIDERS)[number]
/** The provider a chat with no turn yet counts as, such as one imported from before the store. */
export const DEFAULT_PROVIDER = 'anthropic' satisfies ProviderId

/** A provider the app offers, how it can be signed in to, and how it is now. */
export type Login = { provider: ProviderId; name: string; login: LoginKind | null; kinds: LoginKind[] }

/** A sign-in's progress: a page to open (with a code to enter there, for some), a question, and its end. */
export type LoginEvent =
  | { type: 'login'; provider: ProviderId; step: 'open'; url: string; code?: string }
  | {
      type: 'login'
      provider: ProviderId
      step: 'ask'
      /** `select` answers with one option's id. The others answer with text the person types or pastes. */
      kind: 'text' | 'secret' | 'select' | 'manual_code'
      message: string
      options?: { id: string; label: string }[]
    }
  | { type: 'login'; provider: ProviderId; step: 'done' }
  | { type: 'login'; provider: ProviderId; step: 'failed'; detail: string }

/** A line of a chat from before the store, imported for show: the agent does not read it. */
export type ImportedEntry =
  | { role: 'user'; text: string; images: string[] }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string; text: string; result: string; failed: boolean }

/**
 * What a `helper` call ran: `task` is the durable task id of the call, which owns the helper's conversation,
 * `conversation` is that conversation's id, and `helper` is the model it ran on.
 */
export type Handoff = { task: string; conversation: number; helper: ModelChoice }

/**
 * One committed line of a chat. Tool calls fold under their assistant line; each result is its own line. A person's
 * message holds the paths of its pictures, which went to the model as pictures, and of its other files, which the
 * message named. An assistant line holds the model its turn ran on. A `helper` call's result holds its handoff.
 */
export type ChatEntry =
  | ({ id: number; kind: 'imported' } & ImportedEntry)
  | { id: number; kind: 'user'; text: string; images: string[]; files: string[] }
  | { id: number; kind: 'assistant'; text: string; calls: { id: string; name: string; args: unknown }[]; model: ModelChoice }
  | { id: number; kind: 'tool'; callId: string; name: string; text: string; failed: boolean; durationMs?: number; handoff?: Handoff }

/**
 * Why a turn stopped before its answer, and the one thing that lets it go on. `retired` marks a lead its provider
 * removed while the turn ran: it goes on once the person chooses another lead.
 */
export type Waiting =
  | { kind: 'login'; provider: string; name: string; fix: string }
  | { kind: 'error'; detail: string; fix: string; retired?: Retired }

/**
 * What a turn runs with, frozen when it was sent: `model` is its lead and `helper` its helper, or null when the lead
 * works alone. A turn sent before pairs has no `helper`.
 */
export type Turn = {
  requestId: string
  model: ModelChoice
  helper?: ModelChoice | null
  thinking: Thinking
  tools: string[]
  instructions: string
  app: string
  startedMs: number
}

/**
 * A chat as read at one point. `seq` grows with each read of a chat's state, across sidecar runs too, so a view read
 * earlier, such as a change that arrives after `chat.open` answered, never takes the place of a newer one's `running`,
 * `waiting`, and `turn`.
 */
export type ChatView = { project: string; entries: ChatEntry[]; running: boolean; waiting: Waiting | null; turn: Turn | null; seq: number }

/** What the store keeps of the app. */
export type StoredState = { setup: Setup; settings: Settings; projects: Project[]; drafts: Record<string, SavedDraft> }

/**
 * The app as the window sees it. `importBlocked` names the projects folder when the chats from before the store could
 * not be read from it, as when macOS keeps Documents from the app, so the window can say how to let them in.
 */
export type AppState = StoredState & { importBlocked: string | null }

/**
 * The versions of the build tools the agent's `run` tool uses, or null for one that is missing. uv finds the Python,
 * so without uv there is no Python to name.
 */
export type Toolchain = { uv: null } | { uv: string; python: string | null }

/** Something the agent needs before a message can go out, and the one thing that gives it. */
export type Need =
  | { kind: 'login'; provider: ProviderId; name: string; fix: string }
  | { kind: 'model'; fix: string; retired?: Retired }
  | { kind: 'uv'; fix: string }
  | { kind: 'python'; fix: string }

/**
 * The args each of the agent's tools takes, by tool name, in the order the model is offered them. `read`, `write`, and
 * `edit` are Pi's file tools. A committed call holds the args the model sent, which can be malformed.
 */
export type ToolArgs = {
  read: { path: string; offset?: number | undefined; limit?: number | undefined }
  write: { path: string; content: string }
  edit: { path: string; edits: { oldText: string; newText: string }[] }
  run: { args: string[]; timeoutSeconds?: number }
  slice: { inputs: string[]; output: string }
  helper: { task: string }
  /** The tool that handed Astra a task before pairs. Older chats still hold its calls. */
  astra: { task: string }
}
export type ToolName = keyof ToolArgs

/** The tool that hands a task to the chat's helper model. A turn whose chat has no helper is not offered it. */
export const HELPER = 'helper' satisfies ToolName

/** The tool older chats called Astra by. No turn is offered it now. */
export const ASTRA = 'astra' satisfies ToolName

/** Astra, the GPT helper before pairs: OpenAI's model on the person's ChatGPT plan. A chat from then keeps it. */
export const ASTRA_MODEL = { provider: 'openai-codex', modelId: 'gpt-6-astra' } as const

/** The program the `run` tool runs. Its `args` go after it. */
export const RUN_PROGRAM = 'uv'

/** What each tool step says: `label` once it ended, and `doing` in the present tense while it runs. */
export const STEP_LINES = {
  read: { label: 'Read', doing: 'Reading' },
  write: { label: 'Wrote', doing: 'Writing' },
  edit: { label: 'Edited', doing: 'Editing' },
  run: { label: 'Ran', doing: 'Running' },
  slice: { label: 'Sliced', doing: 'Slicing' },
  helper: { label: 'Asked the helper', doing: 'Asking the helper' },
  astra: { label: 'Asked Astra (GPT)', doing: 'Asking Astra (GPT)' },
} as const satisfies Record<ToolName, { label: string; doing: string }>

/** What the window can ask the sidecar, by method name. */
export interface Methods {
  'app.ping': { params: Record<string, never>; result: { version: string } }
  'state.get': { params: Record<string, never>; result: AppState }
  'setup.set': { params: Setup; result: AppState }
  'settings.set': { params: Partial<Omit<Settings, 'printer'>>; result: AppState }
  /**
   * Saves the printer the next slice runs for. Rust resolves its presets and plate against the validated Bambu Studio
   * first, as a slice does, so a printer it cannot slice for is refused with the reason and nothing is saved.
   */
  'printer.set': { params: Printer; result: AppState }
  /** Saves a draft, and answers the revision it was saved as. */
  'drafts.set': { params: { key: string } & Draft; result: { rev: number } }
  /** Keeps a pasted picture in a file of its own, outside any project, and answers its path, for a draft to keep. */
  'drafts.picture': { params: { name: string; data: string }; result: string }
  /**
   * What the agent needs before a send from the project, or from the start screen without one: a replacement for each
   * of the project's models its provider retired, lead first, its lead's sign-in, uv, and a Python uv can run. Empty
   * when ready.
   */
  'setup.check': { params: { project?: string }; result: Need[] }
  /** The build tools setup's check shows. */
  'setup.tools': { params: Record<string, never>; result: Toolchain }
  /** Imports the chats from before the store again, as after the person let the app read the projects folder. */
  'legacy.import': { params: Record<string, never>; result: { imported: number; blocked: string | null } }
  'auth.status': { params: Record<string, never>; result: Login[] }
  /** A key, or for Anthropic a proxy's base URL and token. */
  'auth.setKey': { params: { provider: ProviderId; key: string; baseUrl?: string }; result: Login[] }
  'auth.login': { params: { provider: ProviderId }; result: null }
  'auth.answer': { params: { provider: ProviderId; text: string }; result: null }
  'auth.logout': { params: { provider: ProviderId }; result: Login[] }
  'chat.open': { params: { project: string }; result: ChatView }
  /**
   * Sends the draft saved as revision `rev` under `key`, and answers the project it went to. From the start screen it
   * makes that project first. Sent again with the same revision, as after a lost answer, it sends nothing more and
   * answers the same project.
   */
  'chat.send': { params: { key: string; rev: number }; result: { project: Project } }
  'chat.stop': { params: { project: string }; result: null }
  'chat.retry': { params: { project: string }; result: null }
  /** The newest version of each model family, for the providers the person signed in to. Both roles offer this list. */
  'models.list': { params: Record<string, never>; result: ModelOption[] }
  /** Saves the lead model a project's next turn runs on. A model the app cannot run, or a retired one, is refused. */
  'projects.setLead': { params: { project: string; model: ModelChoice }; result: null }
  /** Saves the helper model a project's next turn can hand tasks to, or null for the lead alone. Refused as `setLead`. */
  'projects.setHelper': { params: { project: string; model: ModelChoice | null }; result: null }
  /** Each project's status for the sidebar, by project id. */
  'projects.status': { params: Record<string, never>; result: Record<string, ProjectStatus> }
  /** Marks a project printed, which moves it to the sidebar's Printed group. */
  'projects.markPrinted': { params: { project: string }; result: null }
  /** The tools a project's agent is offered, as Pi resolves them. */
  'agent.tools': { params: { project: string }; result: string[] }
}

export type Method = keyof Methods

/** What the sidecar can ask Rust. */
export interface HostRequests {
  'keychain.get': { params: { account: string }; result: { secret: string | null } }
  'keychain.set': { params: { account: string; secret: string }; result: null }
  'keychain.delete': { params: { account: string }; result: null }
  /** Whether a slice can run for this printer. Refused with the reason when it cannot. */
  'printer.check': { params: Printer; result: null }
  slice: { params: SliceParams; result: SliceResult }
  /** Holds or gives back the update gate's pass. Refused while an update installs. */
  busy: { params: { busy: boolean }; result: null }
}

export type HostRequest = keyof HostRequests

/**
 * Paths are relative to the project folder, which Rust resolves from the project id. Rust slices once per operation:
 * a request that repeats one waits for the first and gets its result.
 */
export interface SliceParams {
  operation: string
  project: string
  inputs: string[]
  output: string
  printer: Printer
}

/** `plate` is the plate the slice ran on: the printer's own choice, or its model's default. */
export interface SliceResult {
  output: string
  parts: number
  printSeconds: number
  filamentGrams: number
  plate: Plate
}

/** What the window hears on the one `sidecar://event` channel: the sidecar's own events and, from Rust, the engine's state. */
export type SidecarEvent =
  | { type: 'ready'; version: string }
  | LoginEvent
  | ({ type: 'chat' } & ChatView)
  | { type: 'engine'; state: (typeof ENGINE_STATES)[number]; detail: string }

export const ENGINE_STATES = ['restarting', 'stopped'] as const

/** Rust to sidecar. */
export type Inbound =
  | { kind: 'call'; id: number; method: string; params: unknown }
  | { kind: 'answer'; id: number; ok: true; value: unknown }
  | { kind: 'answer'; id: number; ok: false; error: string }

/** Sidecar to Rust. */
export type Outbound =
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }
  | { kind: 'request'; id: number; method: HostRequest; params: unknown }
  | { kind: 'event'; event: SidecarEvent }

/**
 * The rest of the contract with Rust. `sidecar/test/fixtures/contract.json` holds each value and the rules between
 * them, and both test suites check their own side against it.
 */

/** Exit codes Rust reads. Anything else is a crash, which Rust answers with a restart. */
export const EXIT = {
  /** Stdin closed, which Rust does only to quit. */
  done: 0,
  /** Another process owns the store. Rust must not restart. */
  storeInUse: 75,
} as const

/** The flags Rust starts the sidecar with, by their `parseArgs` names. */
export const FLAGS = { appVersion: 'app-version', data: 'data', projects: 'projects' } as const

/** Where pasted pictures go: a folder beside the store folder Rust passes as `--data`. */
export const PICTURES_FOLDER = 'pictures'

/** The only variables Rust gives the sidecar, and the only ones the sidecar gives a command its agent runs. */
export const KEPT_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const

/** The app's own folder in each project. The preview and the file list never show it. */
export const META_DIR = '.m3d'

/** Names the file list skips at any depth, beside every name that starts with a dot. */
export const SKIPPED = ['__pycache__', 'node_modules', 'venv'] as const
