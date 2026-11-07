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
    signedIn: (conversation, provider, context, after) => chats.loginFor(conversation, provider, context, after),
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

  // The pipe opens before the reconcile, which asks Rust's Keychain whether a waited-on login is there now.
  const serving = host.serve(handlers({ store, logins, chats, version }), process.stdin)
  const imported = await store.importLegacy(legacyProjects(projects))
  if (imported.length > 0) console.error(`imported ${imported.length} chats from before the store: ${imported.join(', ')}`)
  await busy.watch(store.harness)
  host.emit({ type: 'ready', version })
  await chats.reconcile()
  await serving
  await chats.close()
  await store.close()
  process.exit(EXIT.done)
}
