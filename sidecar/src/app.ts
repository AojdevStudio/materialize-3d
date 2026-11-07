import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { MutableModels } from '@earendil-works/pi-ai'
import { createRegistry } from '@earendil-works/pi-durable'
import { agentExtension, agentTools, ProjectEnv } from './agent'
import { Busy } from './busy'
import { Chats } from './chat'
import { Host } from './host'
import { inferenceModels, KeychainCredentials, Logins } from './inference'
import { legacyProjects } from './legacy'
import { handlers } from './methods'
import { EXIT, type SidecarEvent } from './protocol'
import { Store, StoreInUse } from './store'

export interface SidecarOptions {
  argv: string[]
  /** Tests only: providers beside the app's three, such as a scripted model. */
  addProviders?(models: MutableModels): void
}

/** The sidecar from start to quit: open the store, serve the pipe until stdin closes, then close the store. */
export async function runSidecar({ argv, addProviders }: SidecarOptions): Promise<never> {
  // Stdout carries protocol lines only, so a library that logs cannot corrupt the pipe.
  console.log = console.error
  console.info = console.error
  console.debug = console.error

  const { values } = parseArgs({
    args: argv,
    options: { 'app-version': { type: 'string' }, data: { type: 'string' }, projects: { type: 'string' } },
    strict: true,
  })
  const { data, projects } = values
  if (data === undefined || projects === undefined) throw new Error('usage: --data <store folder> --projects <projects folder>')
  const version = values['app-version'] ?? 'dev'

  const host = new Host((line) => process.stdout.write(line))
  // The credentials keep their index in the store, which needs the models to open, so the index is reached late.
  const credentials = new KeychainCredentials(host, {
    logins: () => store.logins(),
    setLogin: (provider, kind) => store.setLogin(provider, kind),
  })
  const models = inferenceModels(credentials)
  addProviders?.(models)

  const registry = createRegistry()
  const tools = agentTools({
    host,
    projectOf: (conversation) => store.projectOf(conversation),
    signedIn: (conversation, task, provider, context, after) => chats.loginFor(conversation, task, provider, context, after),
    loginSaves: (provider) => store.loginSaves(provider),
  })
  const extension = agentExtension(tools)
  registry.install(extension)

  let store: Store
  try {
    store = await Store.open({
      dataDir: data,
      projectsDir: projects,
      models,
      registry,
      env: ({ cwd }) => {
        if (cwd === undefined) throw new Error('this conversation has no project folder')
        return new ProjectEnv({ cwd })
      },
    })
  } catch (error) {
    if (!(error instanceof StoreInUse)) throw error
    console.error(error.message)
    process.exit(EXIT.storeInUse)
  }
  // A store that fails is not used again. Rust starts a new sidecar, which reopens it from what was committed.
  void store.harness.closed.then((end) => {
    if (end.kind !== 'failed') return
    console.error(`the store failed: ${end.error instanceof Error ? end.error.message : String(end.error)}`)
    process.exit(1)
  })

  const emit = (event: SidecarEvent) => {
    host.emit(event)
    if (event.type === 'login' && event.step === 'done') {
      chats.signedIn(event.provider).catch((error: unknown) => console.error(`resuming turns after a sign-in failed: ${String(error)}`))
    }
  }
  const busy = new Busy(host)
  const chats = new Chats({ store, models, extension, tools, version, busy, emit })
  const logins = new Logins(models, credentials, emit)
  console.error(`agent tools: ${tools.map((tool) => tool.name).join(', ')}`)

  // The import asks Rust for nothing, so it ends before the pipe opens and the first call sees every old chat. Projects
  // already in the index were imported before, and their transcripts are not read again. It runs again when the person
  // asks, as after letting the app read a projects folder macOS kept from it.
  const importOld = async () => {
    const known = new Set((await store.projects()).map((project) => project.id))
    const { found, blocked } = legacyProjects(projects, known)
    const imported = await store.importLegacy(found)
    if (imported.length > 0) console.error(`imported ${imported.length} chats from before the store: ${imported.join(', ')}`)
    return { imported: imported.length, blocked }
  }
  let oldChats = await importOld()
  // A pasted picture is kept until it is sent, which copies it into its project, or its draft lets it go. At the start
  // no window has one pending, so each kept picture no draft names is removed.
  const pictures = join(dirname(data), 'pictures')
  const named = new Set(Object.values((await store.state()).drafts).flatMap((draft) => draft.attachments))
  for (const folder of existsSync(pictures) ? readdirSync(pictures) : []) {
    const files = readdirSync(join(pictures, folder))
    if (!files.some((file) => named.has(join(pictures, folder, file)))) rmSync(join(pictures, folder), { recursive: true, force: true })
  }
  const legacy = {
    blocked: () => oldChats.blocked,
    retry: async () => {
      oldChats = await importOld()
      return oldChats
    },
  }
  // The pipe opens before the pass is asked for and before the reconcile, which asks Rust's Keychain whether a
  // waited-on login is there now.
  const serving = host.serve(handlers({ store, logins, chats, version, legacy, pictures }), process.stdin)
  // Work a crash cut off resumes only with the pass. Without it an update is installing, and the work resumes after
  // the restart.
  const resumable = await busy.watch(store.harness)
  host.emit({ type: 'ready', version })
  if (resumable) await chats.reconcile()
  else {
    // The update restarts the app, and the work resumes then. If the install fails instead, the gate opens again.
    console.error('an update is installing, so the work a crash cut off waits for it')
    void busy
      .pass()
      .then((held) => (held ? chats.reconcile() : undefined))
      .catch((error: unknown) => console.error(`resuming the work a crash cut off failed: ${String(error)}`))
  }
  await serving
  busy.close()
  await chats.close()
  await store.close()
  process.exit(EXIT.done)
}
