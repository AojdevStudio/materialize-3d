import { runSidecar } from './app'

await runSidecar({ argv: process.argv.slice(2) })
