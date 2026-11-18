// The command layer wd.ts (Linux, WebDriver) and mac.ts (macOS, e2e harness) share:
// the runs folder, what a selector means, the evidence log, and the shared commands.

import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const runsRoot = process.env.M3D_RUNS ?? join(homedir(), 'm3d-verify')

export interface Locator {
  using: 'xpath' | 'css selector'
  value: string
}

// `xpath=<expr>` is XPath. `text=<label>` is the innermost element whose text, with
// whitespace collapsed and trimmed, equals <label>. Anything else is CSS.
export function locator(sel: string): Locator {
  if (sel.startsWith('xpath=')) return { using: 'xpath', value: sel.slice(6) }
  if (sel.startsWith('text=')) {
    const label = JSON.stringify(sel.slice(5)).replaceAll('"', "'")
    return { using: 'xpath', value: `//*[normalize-space(.)=${label}][not(*[normalize-space(.)=${label}])]` }
  }
  return { using: 'css selector', value: sel }
}

export function evidenceLog(evidence: string): (line: string) => void {
  return (line) => appendFileSync(join(evidence, 'actions.log'), `${new Date().toISOString()} ${line}\n`)
}

export interface Driver {
  evidence: string
  wait(sel: string, ms: number): Promise<void>
  click(sel: string): Promise<void>
  text(sel: string): Promise<string>
  count(sel: string): Promise<number>
  screenshot(): Promise<Buffer>
  eval(script: string): Promise<unknown>
}

export type Command = (args: string[]) => Promise<void>

export function sharedCommands(driver: Driver) {
  const log = evidenceLog(driver.evidence)
  return {
    wait: async ([sel, ms]) => {
      await driver.wait(sel, Number(ms ?? 15000))
      log(`wait ${sel} ok`)
    },
    click: async ([sel]) => {
      await driver.click(sel)
      log(`click ${sel}`)
    },
    text: async ([sel]) => {
      const text = await driver.text(sel)
      log(`text ${sel} => ${JSON.stringify(text)}`)
      console.log(text)
    },
    count: async ([sel]) => {
      const n = await driver.count(sel)
      log(`count ${sel} => ${n}`)
      console.log(n)
    },
    shot: async ([name]) => {
      const png = await driver.screenshot()
      const n = readdirSync(driver.evidence).filter((f) => f.endsWith('.png')).length + 1
      const file = join(driver.evidence, `${String(n).padStart(2, '0')}-${name}.png`)
      writeFileSync(file, png)
      log(`shot ${file}`)
      console.log(file)
    },
    eval: async ([script]) => {
      const value = await driver.eval(script)
      log(`eval ${JSON.stringify(script)} => ${JSON.stringify(value)}`)
      console.log(JSON.stringify(value, null, 2))
    },
  } satisfies Record<string, Command>
}

export async function dispatch(commands: Record<string, Command>, [cmd, ...args]: string[], usage: string): Promise<void> {
  if (cmd === undefined || !Object.hasOwn(commands, cmd)) {
    console.error(usage)
    process.exit(2)
  }
  await commands[cmd](args)
}
