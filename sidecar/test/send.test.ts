import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, ChatView, SavedDraft, StoredState } from '../src/protocol'
import { spawnSidecar } from './sidecar'

type App = ReturnType<typeof spawnSidecar>

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-send-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
  chmodSync(join(bin, 'uv'), 0o755)
  return { dir, data: join(dir, 'state'), projects: join(dir, 'projects'), env: { PATH: `${bin}:${process.env.PATH}` } }
}

async function start(where: ReturnType<typeof scratch>): Promise<App> {
  const app = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
  await app.next()
  await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
  return app
}

const state = async (app: App) => (await app.call('state.get')) as StoredState
const drafts = async (app: App): Promise<Record<string, SavedDraft>> => (await state(app)).drafts
const save = async (app: App, key: string, text: string, attachments: string[] = []) =>
  ((await app.call('drafts.set', { key, text, attachments })) as { rev: number }).rev
const send = async (app: App, key: string, rev: number) => ((await app.call('chat.send', { key, rev })) as { project: { id: string; title: string } }).project
const asked = async (app: App, project: string) =>
  ((await app.call('chat.open', { project })) as ChatView).entries.flatMap((entry) => (entry.kind === 'user' ? [entry] : []))

/** Waits until the chat holds this answer, already committed or in a later change. */
async function answered(app: App, project: string, text: string) {
  const has = (entries: ChatEntry[]) => entries.some((entry) => entry.kind === 'assistant' && entry.text === text)
  if (has(((await app.call('chat.open', { project })) as ChatView).entries)) return
  await app.until((event) => event.type === 'chat' && event.project === project && has(event.entries as ChatEntry[]), 30_000)
}

describe('a send from the start screen', () => {
  test('makes the project, sends the draft, and leaves no draft behind', async () => {
    const where = scratch()
    const app = await start(where)
    const rev = await save(app, 'new', 'A knob\nfor a 6 mm shaft')
    const project = await send(app, 'new', rev)
    expect(project.title).toBe('A knob')
    expect(await drafts(app)).toEqual({})
    expect((await asked(app, project.id)).map((entry) => entry.text)).toEqual(['A knob\nfor a 6 mm shaft'])
    await app.quit()
  })

  test('moves only the draft it went out as: a newer start draft is never sent in its place, and stays', async () => {
    const where = scratch()
    const app = await start(where)
    const older = await save(app, 'new', 'A knob')
    const newer = await save(app, 'new', 'A dial')
    await expect(send(app, 'new', older)).rejects.toThrow('The draft changed before it went out. Send it again.')
    expect(await state(app)).toMatchObject({ projects: [], drafts: { new: { text: 'A dial', rev: newer } } })

    const project = await send(app, 'new', newer)
    const latest = await save(app, 'new', 'A shelf bracket')
    // Sent again, as after a lost answer, it changes nothing: the newer start draft stays where it is.
    expect(await send(app, 'new', newer)).toEqual(project)
    expect(await drafts(app)).toEqual({ new: { text: 'A shelf bracket', attachments: [], rev: latest } })
    expect((await asked(app, project.id)).map((entry) => entry.text)).toEqual(['A dial'])
    await app.quit()
  })

  test("sent again after a lost answer never touches the project's newer draft", async () => {
    const where = scratch()
    const app = await start(where)
    const rev = await save(app, 'new', 'A knob')
    const project = await send(app, 'new', rev)
    await answered(app, project.id, 'answered by faux-a')
    const newer = await save(app, project.id, 'Make it thinner')
    expect(await send(app, 'new', rev)).toEqual(project)
    expect(await drafts(app)).toEqual({ [project.id]: { text: 'Make it thinner', attachments: [], rev: newer } })
    expect(await asked(app, project.id)).toHaveLength(1)
    expect((await state(app)).projects).toHaveLength(1)
    await app.quit()
  })

  test('of only a picture goes to one project once, even sent again after the picture is gone', async () => {
    const where = scratch()
    const app = await start(where)
    const photo = join(where.dir, 'photo.jpg')
    writeFileSync(photo, 'jpg')
    const rev = await save(app, 'new', '', [photo])
    const project = await send(app, 'new', rev)
    expect(project.title).toBe('New part')
    rmSync(photo)
    expect(await send(app, 'new', rev)).toEqual(project)
    expect((await state(app)).projects).toHaveLength(1)
    const sent = await asked(app, project.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.images).toEqual([`refs/draft-${rev}/photo.jpg`])
    expect(readdirSync(join(where.projects, project.id, 'refs', `draft-${rev}`))).toEqual(['photo.jpg'])
    await app.quit()
  })

  test('of only a picture leaves the start screen empty, after a relaunch too', async () => {
    const where = scratch()
    const first = await start(where)
    const photo = join(where.dir, 'photo.jpg')
    writeFileSync(photo, 'jpg')
    const rev = await save(first, 'new', '', [photo])
    const project = await send(first, 'new', rev)
    expect(await drafts(first)).toEqual({})
    await first.quit()

    const second = await start(where)
    expect(await state(second)).toMatchObject({ projects: [{ id: project.id }], drafts: {} })
    await second.quit()
  })
})

describe('a send from a project', () => {
  test('of a revision that is no longer the draft sends nothing', async () => {
    const where = scratch()
    const app = await start(where)
    const { project } = await app.sendDraft('new', 'A knob')
    await answered(app, project, 'answered by faux-a')
    const older = await save(app, project, 'Make it red')
    const newer = await save(app, project, 'Make it blue')
    await expect(send(app, project, older)).rejects.toThrow('The draft changed before it went out. Send it again.')
    expect(await asked(app, project)).toHaveLength(1)
    expect((await drafts(app))[project]).toEqual({ text: 'Make it blue', attachments: [], rev: newer })
    await app.quit()
  })

  test('with a picture that is gone fails and keeps the draft', async () => {
    const where = scratch()
    const app = await start(where)
    const { project } = await app.sendDraft('new', 'A knob')
    await answered(app, project, 'answered by faux-a')
    const rev = await save(app, project, 'Like this', [join(where.dir, 'gone.jpg')])
    await expect(send(app, project, rev)).rejects.toThrow("A picture in this message can't be read: gone.jpg. Take it out and send again.")
    expect(await asked(app, project)).toHaveLength(1)
    expect((await drafts(app))[project]?.rev).toBe(rev)
    await app.quit()
  })

  test('copies its pictures once per revision, even when the first try was refused after the copy', async () => {
    const where = scratch()
    const app = await start(where)
    const { project } = await app.sendDraft('new', 'please wait')
    while (!existsSync(join(where.projects, project, 'started'))) await Bun.sleep(25)
    const photo = join(where.dir, 'photo.jpg')
    writeFileSync(photo, 'jpg')
    const rev = await save(app, project, 'Like this', [photo, join(where.dir, 'photo.jpg')])
    await expect(send(app, project, rev)).rejects.toThrow('The agent is still working on the last message.')
    writeFileSync(join(where.projects, project, 'go'), '')
    await answered(app, project, 'answered by faux-a')
    await send(app, project, rev)
    expect(readdirSync(join(where.projects, project, 'refs', `draft-${rev}`)).sort()).toEqual(['photo-2.jpg', 'photo.jpg'])
    expect((await asked(app, project))[1]?.images).toEqual([`refs/draft-${rev}/photo.jpg`, `refs/draft-${rev}/photo-2.jpg`])
    expect((await drafts(app))[project]).toBeUndefined()
    await app.quit()
  }, 30_000)
})
