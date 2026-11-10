/**
 * The app's guide template, made whole when the sidecar is built: a Bun macro, so the page lands in the sidecar as one
 * string. A guide runs in a frame and cannot read the app's fonts or the internet, so the page carries Inter and
 * three.js in itself. The agent's build script fills the one slot left, the `__DATA__` marker, with the guide's data.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The app's own Inter, the latin subset it already ships. */
const INTER = join(import.meta.dir, '../../../src/assets/fonts/Inter-Latin-Variable.woff2')

export function guideTemplate(): string {
  const page = readFileSync(join(import.meta.dir, 'guide.html'), 'utf8')
  const font = readFileSync(INTER).toString('base64')
  // A macro cannot call Bun.build, as the bundler waits on the macro, so the bundle comes from the CLI.
  const built = Bun.spawnSync([process.execPath, 'build', join(import.meta.dir, 'three.js'), '--minify', '--format=iife', '--target=browser'])
  if (!built.success) throw new Error(`bundling three.js for the guide template failed: ${built.stderr.toString()}`)
  // Replaced by functions, as a string replacement would read `$&` and its kin in the minified code as patterns.
  return page.replace('/*__INTER__*/', () => font).replace('/*__THREE__*/', () => built.stdout.toString())
}
