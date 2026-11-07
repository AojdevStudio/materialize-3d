import { parseArgs } from 'node:util'
import { createRegistry } from '@earendil-works/pi-durable'
import { Host } from './host'
import { inferenceModels, KeychainCredentials, Logins } from './inference'
import { handlers } from './methods'
import { EXIT } from './protocol'
import { Store, StoreInUse } from './store'

// Stdout carries protocol lines only, so a library that logs cannot corrupt the pipe.
console.log = console.error
console.info = console.error
console.debug = console.error

const { values } = parseArgs({
  options: {
    'app-version': { type: 'string' },
    data: { type: 'string' },
    projects: { type: 'string' },
  },
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

let store: Store
try {
  store = await Store.open({ dataDir: data, projectsDir: projects, models, registry: createRegistry() })
} catch (error) {
  if (!(error instanceof StoreInUse)) throw error
  console.error(error.message)
  process.exit(EXIT.storeInUse)
}

const logins = new Logins(models, credentials, (event) => host.emit(event))
host.emit({ type: 'ready', version })
await host.serve(handlers(store, logins, version), process.stdin)
await store.close()
process.exit(EXIT.done)
