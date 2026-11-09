import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, ChatView, ProjectStatus } from '../src/protocol'
import { spawnSidecar } from './sidecar'

type App = ReturnType<typeof spawnSidecar>

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-status-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
  chmodSync(join(bin, 'uv'), 0o755)
  return { data: join(dir, 'state'), projects: join(dir, 'projects'), env: { PATH: `${bin}:${process.env.PATH}` } }
}

async function start(where: ReturnType<typeof scratch>): Promise<App> {
  const app = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
  await app.next()
  await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
  return app
}

/** The project's status as the sidebar reads it. */
async function status(app: App, project: string): Promise<ProjectStatus> {
  const row = ((await app.call('projects.status')) as Record<string, ProjectStatus>)[project]
  if (row === undefined) throw new Error(`no status for ${project}`)
  return row
}

/** Waits until the project's turn has answered and ended. */
async function idle(app: App, project: string) {
  for (;;) {
    const view = (await app.call('chat.open', { project })) as ChatView
    if (!view.running && view.entries.some((entry: ChatEntry) => entry.kind === 'assistant')) return
    await Bun.sleep(100)
  }
}

describe('project status', () => {
  test('counts the .3mf files outside refs/ and hidden folders, and keeps the printed mark across a relaunch', async () => {
    const where = scratch()
    const app = await start(where)
    const { project } = await app.sendDraft('new', 'A cable clip')
    await idle(app, project)
    const before = await status(app, project)
    expect(before).toMatchObject({ running: false, printed: false, printFiles: 0 })

    const folder = join(where.projects, project)
    for (const dir of ['plates', 'refs', '.m3d']) mkdirSync(join(folder, dir), { recursive: true })
    for (const file of ['clip.3mf', 'plates/clip-b.3MF', 'refs/theirs.3mf', '.m3d/kept.3mf']) writeFileSync(join(folder, file), '')
    const ready = await status(app, project)
    expect(ready.printFiles).toBe(2)
    expect(ready.lastMs).toBeGreaterThanOrEqual(before.lastMs)

    await app.call('projects.markPrinted', { project })
    expect((await status(app, project)).printed).toBe(true)
    await app.quit()

    const again = await start(where)
    expect(await status(again, project)).toMatchObject({ printed: true, printFiles: 2 })
    await expect(again.call('projects.markPrinted', { project: 'no-such-project' })).rejects.toThrow('no project no-such-project')
    await again.quit()
  }, 30_000)
})
