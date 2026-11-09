/**
 * The pipe between the Rust core and the sidecar: one JSON object per line, each way.
 *
 * The window calls the sidecar through Rust (`invoke('sidecar')`) and hears it on one event. The sidecar asks
 * Rust for what only Rust can do: the Keychain and the Bambu slice step. This file imports nothing, so the
 * window's code can share its types.
 */

export type ModelChoice = { provider: string; modelId: string }

/** A model the picker offers: one of a signed-in provider's models, with the name the provider gives it. */
export type ModelOption = ModelChoice & { name: string }
export type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Where first-launch setup stands. Setup reopens on `step` until it is `done`. */
export type Setup = { step: 'welcome' | 'check' | 'model' | 'printer' | 'ready'; done: boolean }

/** What the next turn starts with. A running turn keeps what it started with. */
export type Settings = {
  model: ModelChoice
  thinking: Thinking
  printer: { machine: string; process: string; filament: string }
}

/**
 * `conversation` is the project's Pi conversation id. `printed` is set once the person marks the project printed.
 * `model` is the model the project's next turn runs on. A project gets the app's default when it is made. A project
 * from before the picker has none, and runs on the default until the person picks one.
 */
export type Project = { id: string; conversation: number; title: string; createdMs: number; printed?: boolean; model?: ModelChoice }

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

export type ProviderId = 'anthropic' | 'openai-codex' | 'opencode-go'

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
 * One committed line of a chat. Tool calls fold under their assistant line; each result is its own line. A person's
 * message holds the paths of its pictures, which went to the model as pictures, and of its other files, which the
 * message named.
 */
export type ChatEntry =
  | ({ id: number; kind: 'imported' } & ImportedEntry)
  | { id: number; kind: 'user'; text: string; images: string[]; files: string[] }
  | { id: number; kind: 'assistant'; text: string; calls: { id: string; name: string; args: unknown }[] }
  | { id: number; kind: 'tool'; callId: string; name: string; text: string; failed: boolean }

/** Why a turn stopped before its answer, and the one thing that lets it go on. */
export type Waiting =
  | { kind: 'login'; provider: string; name: string; fix: string }
  | { kind: 'error'; detail: string; fix: string }

/** What a turn runs with, frozen when it was sent. */
export type Turn = {
  requestId: string
  model: ModelChoice
  thinking: Thinking
  tools: string[]
  instructions: string
  app: string
  startedMs: number
}

/** A chat as the window shows it: committed entries, and whether a turn runs, waits, or neither. */
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

/** Something the agent needs before a message can go out, and the one thing that gives it. */
export type Need =
  | { kind: 'login'; provider: ProviderId; name: string; fix: string }
  | { kind: 'model'; fix: string }
  | { kind: 'uv'; fix: string }
  | { kind: 'python'; fix: string }

/** What the window can ask the sidecar, by method name. */
export interface Methods {
  'app.ping': { params: Record<string, never>; result: { version: string } }
  'state.get': { params: Record<string, never>; result: AppState }
  'setup.set': { params: Setup; result: AppState }
  'settings.set': { params: Partial<Settings>; result: AppState }
  /** Saves a draft, and answers the revision it was saved as. */
  'drafts.set': { params: { key: string } & Draft; result: { rev: number } }
  /** Keeps a pasted picture in a file of its own, outside any project, and answers its path, for a draft to keep. */
  'drafts.picture': { params: { name: string; data: string }; result: string }
  /** What the agent needs before a send: the chosen model's sign-in, uv, and a Python uv can run. Empty when ready. */
  'setup.check': { params: Record<string, never>; result: Need[] }
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
  /** The models of each provider the person signed in to, as that provider lists them. */
  'models.list': { params: Record<string, never>; result: ModelOption[] }
  /** Saves the model a project's next turn runs on. */
  'projects.setModel': { params: { project: string; model: ModelChoice }; result: null }
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
}

export interface SliceResult {
  output: string
  parts: number
  printSeconds: number
  filamentGrams: number
}

/** What the window hears on the one `sidecar://event` channel: the sidecar's own events and, from Rust, the engine's state. */
export type SidecarEvent =
  | { type: 'ready'; version: string }
  | LoginEvent
  | ({ type: 'chat' } & ChatView)
  | { type: 'engine'; state: 'restarting' | 'stopped'; detail: string }

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

/** Exit codes Rust reads. Anything else is a crash, which Rust answers with a restart. */
export const EXIT = {
  /** Stdin closed: the app is quitting. */
  done: 0,
  /** Another process owns the store. Rust must not restart. */
  storeInUse: 75,
} as const
