import { parseArgs } from 'node:util'
import { compile, obj } from '@earendil-works/pi-schema'
import { Host } from './host'
import { EXIT } from './protocol'

// Stdout carries protocol lines only, so a library that logs cannot corrupt the pipe.
console.log = console.error
console.info = console.error
console.debug = console.error

const { values } = parseArgs({ options: { 'app-version': { type: 'string' } }, strict: true })
const version = values['app-version'] ?? 'dev'

const host = new Host((line) => process.stdout.write(line))
host.emit({ type: 'ready', version })
await host.serve(
  {
    'app.ping': { params: compile(obj({})), run: async () => ({ version }) },
  },
  process.stdin,
)
process.exit(EXIT.done)
