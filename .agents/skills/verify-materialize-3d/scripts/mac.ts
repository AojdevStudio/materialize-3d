#!/usr/bin/env bun
// macOS driver for Materialize 3D. WebDriver cannot drive WKWebView, so this
// talks to the app's `e2e` verification harness (src-tauri/src/e2e.rs), which
// exists only in builds made with `--features e2e`. Run it on the Mac itself.
//
//   bun mac.ts build                 bun tauri build --debug --bundles app --features e2e
//   bun mac.ts up                    launch the built app with a fresh data dir; prints the run dir
//   bun mac.ts wait <sel> [ms]       wait until <sel> is visible
//   bun mac.ts click <sel>           click through the DOM (the same handlers a person triggers)
//   bun mac.ts type <sel> <text>     set an input's value and fire input/change events
//   bun mac.ts text <sel>            print visible text
//   bun mac.ts count <sel>           print the number of matches
//   bun mac.ts shot <name>           save evidence/NN-<name>.png (WebKit snapshot, no Screen Recording needed)
//   bun mac.ts eval <js>             run an async function body; inspection only
//   bun mac.ts restart               quit and relaunch on the same data (proves persistence)
//   bun mac.ts dialog <open-path>    the next Open skips the native panel and takes this path
//   bun mac.ts down                  quit the app we launched; keeps evidence
//
// Selectors are the ones commands.ts defines for both drivers.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import tauriConf from '../../../../src-tauri/tauri.conf.json'
import { type Command, type Driver, dispatch, evidenceLog, locator, runsRoot, sharedCommands } from './commands.ts'

interface Run {
  dir: string
  port: number
  token: string
  pid: number
}

async function launch(run: Run): Promise<number> {
  const envs = [
    `M3D_E2E_DATA_DIR=${join(run.dir, 'data')}`,
    `M3D_E2E_PORT=${run.port}`,
    `M3D_E2E_TOKEN=${run.token}`,
    `BAMBU_STUDIO_CLI=${process.env.BAMBU_STUDIO_CLI ?? bambu}`,
  ]
  const opened = spawnSync('open', ['-n', '-g', ...envs.flatMap((e) => ['--env', e]), appPath])
  if (opened.status !== 0) throw new Error(`open failed: ${opened.stderr}`)
  // Health answers once the harness binds; the webview can take longer to accept scripts.
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await evalJs<number>(run, 'return 1', 2000).then(() => true, () => false)
    if (!ready) await Bun.sleep(500)
  }
  if (!ready) throw new Error('app did not become scriptable within 60 s')
  return Number(spawnSync('pgrep', ['-nf', `${appPath}/Contents/MacOS/${binaryName()}`]).stdout.toString().trim())
}

interface CargoMetadata {
  packages: Array<{ targets: Array<{ name: string; kind: string[] }> }>
}

function binaryName(): string {
  const meta = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', join(root, 'src-tauri/Cargo.toml')])
  if (meta.status !== 0) throw new Error(`cargo metadata failed: ${meta.stderr}`)
  const { packages } = JSON.parse(meta.stdout.toString()) as CargoMetadata
  const bin = packages.flatMap((p) => p.targets).find((t) => t.kind.length === 1 && t.kind[0] === 'bin')
  if (bin === undefined) throw new Error('cargo metadata names no binary in src-tauri/Cargo.toml')
  return bin.name
}

const root = resolve(import.meta.dir, '../../../..')
const currentFile = join(runsRoot, 'current-mac.json')
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, 'src-tauri/target')
const appPath = join(targetDir, `debug/bundle/macos/${tauriConf.productName}.app`)
const bambu = join(homedir(), 'Applications/BambuStudio-02.08.02.61/BambuStudio.app/Contents/MacOS/BambuStudio')

function current(): Run {
  if (!existsSync(currentFile)) throw new Error('no active mac run; run "mac.ts up" first')
  return JSON.parse(readFileSync(currentFile, 'utf8')) as Run
}

async function call(run: Run, path: string, body?: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${run.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${run.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function evalJs<T>(run: Run, script: string, timeoutMs = 15000): Promise<T> {
  const res = await call(run, '/eval', { script, timeoutMs })
  if (!res.ok) throw new Error(`eval HTTP ${res.status}: ${await res.text()}`)
  const result = (await res.json()) as { ok: boolean; value: string }
  if (!result.ok) throw new Error(`script threw: ${result.value}`)
  return JSON.parse(result.value) as T
}

const FIND = `const find = ({ using, value }) => {
  if (using === 'css selector') return [...document.querySelectorAll(value)];
  const found = document.evaluate(value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const nodes = Array.from({ length: found.snapshotLength }, (_, i) => found.snapshotItem(i));
  if (!nodes.every((n) => n instanceof Element)) throw new Error('invalid selector: ' + value + ' matches a node that is not an element');
  return nodes;
};
const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };`

const find = (sel: string) => `find(${JSON.stringify(locator(sel))})`

async function waitFor(run: Run, sel: string, ms = 15000): Promise<void> {
  const script = `${FIND}
const deadline = Date.now() + ${ms};
while (Date.now() < deadline) {
  if (${find(sel)}.some(visible)) return true;
  await new Promise((r) => setTimeout(r, 200));
}
throw new Error('timed out waiting for ' + ${JSON.stringify(sel)});`
  await evalJs(run, script, ms + 5000)
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'build') {
    const built = spawnSync('bun', ['tauri', 'build', '--debug', '--bundles', 'app', '--features', 'e2e'], {
      cwd: root,
      env: { ...process.env, VITE_M3D_E2E: '1' },
      stdio: 'inherit',
    })
    process.exit(built.status ?? 1)
  }
  if (cmd === 'up') {
    if (existsSync(currentFile)) throw new Error(`run already active: ${currentFile}; run "mac.ts down" first`)
    if (!existsSync(appPath)) throw new Error(`no e2e build at ${appPath}; run "mac.ts build" first`)
    const dir = join(runsRoot, `mac-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(join(dir, 'evidence'), { recursive: true })
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = probe.port
    probe.stop(true)
    const run: Run = { dir, port, token: crypto.randomUUID() + crypto.randomUUID(), pid: 0 }
    run.pid = await launch(run)
    mkdirSync(runsRoot, { recursive: true })
    writeFileSync(currentFile, JSON.stringify(run), { mode: 0o600 })
    evidenceLog(join(dir, 'evidence'))(`up pid=${run.pid} app=${appPath}`)
    console.log(dir)
    return
  }
  const run = current()
  const evidence = join(run.dir, 'evidence')
  const log = evidenceLog(evidence)
  const driver: Driver = {
    evidence,
    wait: (sel, ms) => waitFor(run, sel, ms),
    click: async (sel) => {
      await waitFor(run, sel)
      await evalJs(run, `${FIND} ${find(sel)}.find(visible).click(); return true;`)
    },
    text: async (sel) => {
      await waitFor(run, sel)
      return evalJs<string>(run, `${FIND} return ${find(sel)}.find(visible).innerText;`)
    },
    count: (sel) => evalJs<number>(run, `${FIND} return ${find(sel)}.length;`),
    screenshot: async () => {
      const res = await call(run, '/snapshot')
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}: ${await res.text()}`)
      return Buffer.from(await res.arrayBuffer())
    },
    eval: (script) => evalJs<unknown>(run, script),
  }
  const commands: Record<string, Command> = {
    ...sharedCommands(driver),
    type: async ([sel, text]) => {
      await waitFor(run, sel)
      await evalJs(
        run,
        `${FIND} const el = ${find(sel)}.find(visible);
const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
setter.call(el, ${JSON.stringify(text)});
el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
return true;`,
      )
      log(`type ${sel} (${text.length} chars)`)
    },
    restart: async () => {
      if (run.pid > 0) spawnSync('kill', [String(run.pid)])
      for (let i = 0; i < 40 && spawnSync('kill', ['-0', String(run.pid)]).status === 0; i++) await Bun.sleep(250)
      run.pid = await launch(run)
      writeFileSync(currentFile, JSON.stringify(run), { mode: 0o600 })
      log(`restart pid=${run.pid}`)
    },
    dialog: async ([openPath]) => {
      // The native Open panel is outside the webview. In the e2e build that
      // `build` makes, the app's file-dialog helper (src/lib/fileDialog.ts) reads
      // the next path from this global instead of opening the panel, so a run
      // that uses it does not cover the native panel itself.
      if (!openPath) throw new Error('usage: mac.ts dialog <open-path>')
      await evalJs(run, `window.__M3D_E2E_DIALOGS__ = { nextOpenPath: ${JSON.stringify(openPath)} };
return true;`)
      log(`dialog open=${openPath}`)
    },
    down: async () => {
      if (run.pid > 0) spawnSync('kill', [String(run.pid)])
      spawnSync('rm', ['-f', currentFile])
      console.log(`down; evidence kept at ${evidence}`)
    },
  }
  await dispatch(commands, [cmd, ...args], 'usage: mac.ts build|up|wait|click|type|text|count|shot|eval|restart|dialog|down (see header)')
}

main().catch((err: unknown) => {
  console.error(`mac: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
