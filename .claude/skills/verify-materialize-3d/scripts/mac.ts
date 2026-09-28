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
//   bun mac.ts dialog <open-path> [save-path]  answer the next native file dialogs with these paths
//   bun mac.ts down                  quit the app we launched; keeps evidence
//
// Selectors are CSS, or `text=<label>` for the innermost element with exactly that text.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
  return Number(spawnSync('pgrep', ['-nf', `${appPath}/Contents/MacOS/materialize-3d`]).stdout.toString().trim())
}

const root = resolve(import.meta.dir, '../../../..')
const runsRoot = process.env.M3D_RUNS ?? join(homedir(), 'm3d-verify')
const currentFile = join(runsRoot, 'current-mac.json')
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, 'src-tauri/target')
const appPath = join(targetDir, 'debug/bundle/macos/Materialize 3D.app')
const bambu = join(homedir(), 'Applications/BambuStudio-02.08.02.61/BambuStudio.app/Contents/MacOS/BambuStudio')

function current(): Run {
  if (!existsSync(currentFile)) throw new Error('no active mac run; run "mac.ts up" first')
  return JSON.parse(readFileSync(currentFile, 'utf8')) as Run
}

function log(run: Run, line: string): void {
  appendFileSync(join(run.dir, 'evidence/actions.log'), `${new Date().toISOString()} ${line}\n`)
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

const FIND = `const find = (sel) => {
  if (sel.startsWith('text=')) {
    const label = sel.slice(5);
    return [...document.querySelectorAll('body *')].filter((el) => el.textContent.trim() === label &&
      ![...el.children].some((c) => c.textContent.trim() === label));
  }
  return [...document.querySelectorAll(sel)];
};
const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };`

async function waitFor(run: Run, sel: string, ms = 15000): Promise<void> {
  const script = `${FIND}
const deadline = Date.now() + ${ms};
while (Date.now() < deadline) {
  if (find(${JSON.stringify(sel)}).some(visible)) return true;
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
    log(run, `up pid=${run.pid} app=${appPath}`)
    console.log(dir)
    return
  }
  const run = current()
  switch (cmd) {
    case 'wait':
      await waitFor(run, args[0], Number(args[1] ?? 15000))
      log(run, `wait ${args[0]} ok`)
      return
    case 'click':
      await waitFor(run, args[0])
      await evalJs(run, `${FIND} const el = find(${JSON.stringify(args[0])}).find(visible); el.click(); return true;`)
      log(run, `click ${args[0]}`)
      return
    case 'type': {
      await waitFor(run, args[0])
      await evalJs(
        run,
        `${FIND} const el = find(${JSON.stringify(args[0])}).find(visible);
const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
setter.call(el, ${JSON.stringify(args[1])});
el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
return true;`,
      )
      log(run, `type ${args[0]} (${args[1].length} chars)`)
      return
    }
    case 'text': {
      await waitFor(run, args[0])
      const text = await evalJs<string>(run, `${FIND} return find(${JSON.stringify(args[0])}).find(visible).innerText;`)
      log(run, `text ${args[0]} => ${JSON.stringify(text)}`)
      console.log(text)
      return
    }
    case 'count': {
      const n = await evalJs<number>(run, `${FIND} return find(${JSON.stringify(args[0])}).length;`)
      log(run, `count ${args[0]} => ${n}`)
      console.log(n)
      return
    }
    case 'shot': {
      const res = await call(run, '/snapshot')
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}: ${await res.text()}`)
      const evidence = join(run.dir, 'evidence')
      const n = readdirSync(evidence).filter((f) => f.endsWith('.png')).length + 1
      const file = join(evidence, `${String(n).padStart(2, '0')}-${args[0]}.png`)
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      log(run, `shot ${file}`)
      console.log(file)
      return
    }
    case 'eval': {
      const value = await evalJs<unknown>(run, args[0])
      log(run, `eval ${JSON.stringify(args[0])} => ${JSON.stringify(value)}`)
      console.log(JSON.stringify(value, null, 2))
      return
    }
    case 'restart': {
      if (run.pid > 0) spawnSync('kill', [String(run.pid)])
      for (let i = 0; i < 40 && spawnSync('kill', ['-0', String(run.pid)]).status === 0; i++) await Bun.sleep(250)
      run.pid = await launch(run)
      writeFileSync(currentFile, JSON.stringify(run), { mode: 0o600 })
      log(run, `restart pid=${run.pid}`)
      return
    }
    case 'dialog': {
      // Native Open/Save panels are outside the webview; the app's file-dialog
      // helper (src/lib/fileDialog.ts) answers the next one from this global.
      const [openPath, savePath] = args
      await evalJs(
        run,
        `window.__M3D_E2E_DIALOGS__ = { nextOpenPath: ${JSON.stringify(openPath)}, nextSavePath: ${JSON.stringify(savePath)} };
return true;`,
      )
      log(run, `dialog open=${openPath ?? ''} save=${savePath ?? ''}`)
      return
    }
    case 'down': {
      if (run.pid > 0) spawnSync('kill', [String(run.pid)])
      spawnSync('rm', ['-f', currentFile])
      console.log(`down; evidence kept at ${join(run.dir, 'evidence')}`)
      return
    }
    default:
      console.error('usage: mac.ts build|up|wait|click|type|text|count|shot|eval|down (see header)')
      process.exit(2)
  }
}

main().catch((err: unknown) => {
  console.error(`mac: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
