import { arr, bool, compile, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import type { Handlers } from './host'
import type { Store } from './store'

const step = union([lit('welcome'), lit('check'), lit('model'), lit('printer'), lit('ready')])
const thinking = union([lit('off'), lit('minimal'), lit('low'), lit('medium'), lit('high'), lit('xhigh'), lit('max')])
const model = obj({ provider: str(), modelId: str() })
const printer = obj({ machine: str(), process: str(), filament: str() })

/** Every method the window can call, each parsed at the pipe before it runs. */
export function handlers(store: Store, version: string): Handlers {
  return {
    'app.ping': { params: compile(obj({})), run: async () => ({ version }) },
    'state.get': { params: compile(obj({})), run: () => store.state() },
    'setup.set': {
      params: compile(obj({ step, done: bool() })),
      run: async (setup) => {
        await store.setSetup(setup)
        return store.state()
      },
    },
    'settings.set': {
      params: compile(obj({ model: opt(model), thinking: opt(thinking), printer: opt(printer) })),
      run: async (change) => {
        await store.setSettings(change)
        return store.state()
      },
    },
    'drafts.set': {
      params: compile(obj({ key: str(), text: str(), attachments: arr(str()) })),
      run: async ({ key, text, attachments }) => {
        await store.setDraft(key, { text, attachments })
        return null
      },
    },
    'projects.create': { params: compile(obj({ title: str() })), run: ({ title }) => store.createProject(title) },
  }
}
