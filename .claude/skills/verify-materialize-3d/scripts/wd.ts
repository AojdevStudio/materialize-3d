#!/usr/bin/env bun
// WebDriver client for the Materialize 3D verification run started by m3d.sh.
// Talks raw W3C WebDriver to tauri-driver, which launches the real Tauri binary
// through WebKitWebDriver. Every command is appended to <run>/evidence/actions.log
// so a proof records the action next to the resulting state.
//
// Selectors: plain CSS by default, `xpath=<expr>` for XPath, and `text=<label>`
// for the innermost element whose normalized text equals <label>.
//
//   bun wd.ts session                  start the app (one session per run)
//   bun wd.ts wait <sel> [ms]          wait until <sel> is displayed (default 15000)
//   bun wd.ts gone <sel> [ms]          wait until <sel> is absent or hidden
//   bun wd.ts click <sel>
//   bun wd.ts hover <sel>              move the pointer over <sel> (reveals hover-only controls)
//   bun wd.ts type <sel> <text> [--clear]
//   bun wd.ts keys <text>              send keys to the focused element ( = Enter)
//   bun wd.ts text <sel>               print visible text
//   bun wd.ts attr <sel> <name>        print a DOM property of the first match (visible or not)
//   bun wd.ts count <sel>              print the number of matches
//   bun wd.ts shot <name>              save evidence/<NN>-<name>.png of the webview
//   bun wd.ts eval <js>                run a script (`return ...`), print JSON; inspection only
//   bun wd.ts note <message>           append a free-form line to actions.log
//   bun wd.ts end                      close the session (the app exits)

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

interface RunEnv {
  run: string
  driverPort: number
  binary: string
}

interface WebDriverError {
  error: string
  message: string
}

type WebDriverReply<T> = { value: T | WebDriverError }

const runsRoot = process.env.M3D_RUNS ?? join(process.env.HOME ?? '', 'm3d-verify')
const current = join(runsRoot, 'current')
if (!existsSync(join(current, 'env.json'))) {
  console.error(`wd: no active run at ${current}; run "m3d.sh up" first`)
  process.exit(2)
}
const env: RunEnv = JSON.parse(readFileSync(join(current, 'env.json'), 'utf8'))
const base = `http://127.0.0.1:${env.driverPort}`
const evidence = join(env.run, 'evidence')
const sessionFile = join(env.run, 'session')

function log(line: string): void {
  appendFileSync(join(evidence, 'actions.log'), `${new Date().toISOString()} ${line}\n`)
}

function isError(value: unknown): value is WebDriverError {
  return typeof value === 'object' && value !== null && 'error' in value
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: object): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const reply = (await res.json()) as WebDriverReply<T>
  if (isError(reply.value)) throw new Error(`${method} ${path}: ${reply.value.error}: ${reply.value.message}`)
  return reply.value
}

function sid(): string {
  if (!existsSync(sessionFile)) throw new Error('no session; run "wd.ts session" first')
  return readFileSync(sessionFile, 'utf8').trim()
}

function locator(sel: string): { using: string; value: string } {
  if (sel.startsWith('xpath=')) return { using: 'xpath', value: sel.slice(6) }
  if (sel.startsWith('text=')) {
    const label = JSON.stringify(sel.slice(5)).replaceAll('"', "'")
    return { using: 'xpath', value: `//*[normalize-space(.)=${label}][not(*[normalize-space(.)=${label}])]` }
  }
  return { using: 'css selector', value: sel }
}

async function findAll(sel: string): Promise<string[]> {
  const found = await call<Array<Record<string, string>>>('POST', `/session/${sid()}/elements`, locator(sel))
  return found.map((el) => el[ELEMENT_KEY])
}

async function displayed(id: string): Promise<boolean> {
  return call<boolean>('GET', `/session/${sid()}/element/${id}/displayed`).catch(() => false)
}

// Resolves to the first match (the first displayed one unless `present` is set),
// polling until the deadline.
async function waitFor(sel: string, ms = 15000, present = false): Promise<string> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    for (const id of await findAll(sel)) if (present || (await displayed(id))) return id
    await Bun.sleep(250)
  }
  throw new Error(`timed out after ${ms}ms waiting for ${sel}`)
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case 'session': {
      const created = await call<{ sessionId: string }>('POST', '/session', {
        capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: env.binary } } },
      })
      writeFileSync(sessionFile, created.sessionId)
      log(`session ${created.sessionId} ${env.binary}`)
      console.log(created.sessionId)
      return
    }
    case 'wait': {
      await waitFor(args[0], Number(args[1] ?? 15000))
      log(`wait ${args[0]} ok`)
      return
    }
    case 'gone': {
      const deadline = Date.now() + Number(args[1] ?? 15000)
      while (Date.now() < deadline) {
        const visible = await Promise.all((await findAll(args[0])).map(displayed))
        if (!visible.includes(true)) {
          log(`gone ${args[0]} ok`)
          return
        }
        await Bun.sleep(250)
      }
      throw new Error(`${args[0]} still displayed`)
    }
    case 'click': {
      const id = await waitFor(args[0])
      await call('POST', `/session/${sid()}/element/${id}/click`, {})
      log(`click ${args[0]}`)
      return
    }
    case 'hover': {
      const id = await waitFor(args[0], 15000, true)
      await call('POST', `/session/${sid()}/actions`, {
        actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: { [ELEMENT_KEY]: id }, x: 0, y: 0 }] }],
      })
      log(`hover ${args[0]}`)
      return
    }
    case 'type': {
      const [sel, text] = args
      const id = await waitFor(sel)
      if (args.includes('--clear')) await call('POST', `/session/${sid()}/element/${id}/clear`, {})
      await call('POST', `/session/${sid()}/element/${id}/value`, { text })
      log(`type ${sel} ${JSON.stringify(text)}`)
      return
    }
    case 'keys': {
      const active = await call<Record<string, string>>('GET', `/session/${sid()}/element/active`)
      await call('POST', `/session/${sid()}/element/${active[ELEMENT_KEY]}/value`, { text: args[0] })
      log(`keys ${JSON.stringify(args[0])}`)
      return
    }
    case 'text': {
      const id = await waitFor(args[0])
      const text = await call<string>('GET', `/session/${sid()}/element/${id}/text`)
      log(`text ${args[0]} => ${JSON.stringify(text)}`)
      console.log(text)
      return
    }
    case 'attr': {
      const id = await waitFor(args[0], 15000, true)
      const value = await call<unknown>('GET', `/session/${sid()}/element/${id}/property/${args[1]}`)
      log(`attr ${args[0]} ${args[1]} => ${JSON.stringify(value)}`)
      console.log(typeof value === 'string' ? value : JSON.stringify(value))
      return
    }
    case 'count': {
      const n = (await findAll(args[0])).length
      log(`count ${args[0]} => ${n}`)
      console.log(n)
      return
    }
    case 'shot': {
      const png = await call<string>('GET', `/session/${sid()}/screenshot`)
      const n = readdirSync(evidence).filter((f) => f.endsWith('.png')).length + 1
      const file = join(evidence, `${String(n).padStart(2, '0')}-${args[0]}.png`)
      writeFileSync(file, Buffer.from(png, 'base64'))
      log(`shot ${file}`)
      console.log(file)
      return
    }
    case 'eval': {
      const value = await call<unknown>('POST', `/session/${sid()}/execute/sync`, { script: args[0], args: [] })
      log(`eval ${JSON.stringify(args[0])} => ${JSON.stringify(value)}`)
      console.log(JSON.stringify(value, null, 2))
      return
    }
    case 'note': {
      log(`note ${args.join(' ')}`)
      return
    }
    case 'end': {
      await call('DELETE', `/session/${sid()}`)
      log('end')
      return
    }
    default:
      console.error('usage: wd.ts session|wait|gone|click|hover|type|keys|text|attr|count|shot|eval|note|end (see header)')
      process.exit(2)
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  log(`FAIL ${process.argv.slice(2).join(' ')} :: ${message}`)
  console.error(`wd: ${message}`)
  process.exit(1)
})
