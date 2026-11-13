import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, ChatView, Need, ProjectStatus, StoredState } from '../src/protocol'
import { spawnSidecar } from './sidecar'

type App = ReturnType<typeof spawnSidecar>

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-attach-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
  chmodSync(join(bin, 'uv'), 0o755)
  return { dir, data: join(dir, 'state'), projects: join(dir, 'projects'), env: { PATH: `${bin}:${process.env.PATH}` } }
}

async function start(where: ReturnType<typeof scratch>, script: string): Promise<App> {
  const app = spawnSidecar(where.data, where.projects, new Map(), { script, env: where.env })
  await app.next()
  await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
  return app
}

/** A file with these bytes, outside every project, as the person picks it. */
function file(where: ReturnType<typeof scratch>, name: string): string {
  const path = join(where.dir, name)
  writeFileSync(path, name)
  return path
}

/** The chat's answers, once it holds `count` of them, oldest first. */
async function answers(app: App, project: string, count: number): Promise<string[]> {
  const seen = new Map<number, string>()
  const add = (entries: ChatEntry[]) => {
    for (const entry of entries) if (entry.kind === 'assistant' && entry.text !== '') seen.set(entry.id, entry.text)
  }
  add(((await app.call('chat.open', { project })) as ChatView).entries)
  while (seen.size < count) {
    await app.until((event) => {
      if (event.type === 'chat' && event.project === project) add(event.entries as ChatEntry[])
      return seen.size >= count
    }, 30_000)
  }
  return [...seen.entries()].sort(([a], [b]) => a - b).map(([, text]) => text)
}

const sentBy = async (app: App, project: string) =>
  ((await app.call('chat.open', { project })) as ChatView).entries.flatMap((entry) => (entry.kind === 'user' ? [entry] : []))

describe('an attached file', () => {
  test('that is a PDF, a 3MF, or an STL lands in refs/ and reaches the agent by its path, after a reopen too', async () => {
    const where = scratch()
    const first = await start(where, 'attachments')
    const names = ['bracket.pdf', 'bracket.3mf', 'bracket.stl']
    const { project, rev } = await first.sendDraft('new', 'Make this', names.map((name) => file(where, name)))
    const paths = names.map((name) => `refs/draft-${rev}/${name}`)

    const [answer] = await answers(first, project, 1)
    expect(answer).toStartWith('pictures=0 | ')
    for (const rel of paths) {
      expect(readFileSync(join(where.projects, project, rel), 'utf8')).toBe(rel.split('/').pop() ?? '')
      expect(answer).toContain(rel)
    }
    expect(await sentBy(first, project)).toMatchObject([{ text: 'Make this', images: [], files: paths }])
    // The person's own 3MF is a reference, not a print file the agent made.
    expect(((await first.call('projects.status')) as Record<string, ProjectStatus>)[project]?.printFiles).toBe(0)
    await first.quit()

    const second = await start(where, 'attachments')
    await second.sendDraft(project, 'Where are the files?')
    const [, later] = await answers(second, project, 2)
    for (const rel of paths) expect(later).toContain(rel)
    expect(await sentBy(second, project)).toMatchObject([{ files: paths }, { text: 'Where are the files?', files: [] }])
    await second.quit()
  }, 60_000)

  test('that is a picture still goes to the model as a picture', async () => {
    const where = scratch()
    const app = await start(where, 'attachments')
    const { project, rev } = await app.sendDraft('new', 'Like this', [file(where, 'photo.png')])
    const [answer] = await answers(app, project, 1)
    expect(answer).toBe(`pictures=1 | Like this\n\n(Pictures attached, saved in this folder as: refs/draft-${rev}/photo.png)`)
    expect(await sentBy(app, project)).toMatchObject([{ images: [`refs/draft-${rev}/photo.png`], files: [] }])
    await app.quit()
  }, 30_000)

  test('that is a picture the model cannot read goes by its path', async () => {
    const where = scratch()
    const app = await start(where, 'attachments')
    // Off macOS no HEIC photo can be made a JPEG, and on macOS these bytes are no photo.
    const { project, rev } = await app.sendDraft('new', 'Like this', [file(where, 'photo.heic')])
    const [answer] = await answers(app, project, 1)
    expect(answer).toBe(`pictures=0 | Like this\n\n(Files attached, saved in this folder as: refs/draft-${rev}/photo.heic)`)
    // The chat shows it as the file the model got, not as a picture it never saw.
    expect(await sentBy(app, project)).toMatchObject([{ images: [], files: [`refs/draft-${rev}/photo.heic`] }])
    await app.quit()
  }, 30_000)
})

describe('the model', () => {
  const projects = async (app: App) => Object.fromEntries(((await app.call('state.get')) as StoredState).projects.map((p) => [p.id, p.model?.modelId]))

  test('is saved per project, and each project runs on its own after a reopen', async () => {
    const where = scratch()
    const first = await start(where, 'models')
    const { project: a } = await first.sendDraft('new', 'make the project')
    await answers(first, a, 1)
    // The start screen's pick is the model of the next project made there, and leaves the earlier one alone.
    await first.call('settings.set', { model: { provider: 'faux', modelId: 'faux-b' } })
    const { project: b } = await first.sendDraft('new', 'make the project')
    await answers(first, b, 1)
    expect(await projects(first)).toEqual({ [a]: 'faux-a', [b]: 'faux-b' })

    await first.call('projects.setModel', { project: a, model: { provider: 'faux', modelId: 'faux-b' } })
    await first.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    expect(await projects(first)).toEqual({ [a]: 'faux-b', [b]: 'faux-b' })
    await first.quit()

    const second = await start(where, 'models')
    expect(await projects(second)).toEqual({ [a]: 'faux-b', [b]: 'faux-b' })
    await second.sendDraft(a, 'which model?')
    expect((await answers(second, a, 2))[1]).toBe('answered by faux-b')
    await second.call('projects.setModel', { project: b, model: { provider: 'faux', modelId: 'faux-a' } })
    await second.sendDraft(b, 'which model?')
    expect((await answers(second, b, 2))[1]).toBe('answered by faux-a')
    await expect(second.call('projects.setModel', { project: a, model: { provider: 'faux', modelId: 'faux-z' } })).rejects.toThrow('faux has no model faux-z')
    await second.quit()
  }, 60_000)

  test("is the one readiness checks the sign-in for: the open project's own, or the default on the start screen", async () => {
    const where = scratch()
    const app = await start(where, 'models')
    const { project } = await app.sendDraft('new', 'make the project')
    await answers(app, project, 1)
    await app.call('projects.setModel', { project, model: { provider: 'anthropic', modelId: 'claude-opus-5-5' } })
    await app.call('settings.set', { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' } })
    const logins = async (params: object) =>
      ((await app.call('setup.check', params)) as Need[]).flatMap((need) => (need.kind === 'login' ? [need.provider] : []))
    expect(await logins({ project })).toEqual(['anthropic'])
    expect(await logins({})).toEqual(['openai-codex'])
    await app.call('auth.setKey', { provider: 'anthropic', key: 'sk-test-dummy-0000' })
    expect(await logins({ project })).toEqual([])
    expect(await logins({})).toEqual(['openai-codex'])
    await app.quit()
  }, 30_000)

  test("list holds the app's short list for the providers the person signed in to, by short name with one line each, and only models they run", async () => {
    const where = scratch()
    const app = await start(where, 'models')
    expect(await app.call('models.list')).toEqual([])
    await app.call('auth.setKey', { provider: 'anthropic', key: 'sk-test-dummy-0000' })
    // pi-ai 1.5.0 has no Fable 5.2, so its row waits until the catalog lists it.
    const anthropic = [
      { provider: 'anthropic', modelId: 'claude-opus-5-5', name: 'Opus 5.5', description: 'Best for design and checks. Recommended.' },
      { provider: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Faster, a little less careful.' },
    ]
    expect(await app.call('models.list')).toEqual(anthropic)
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'sk-test-dummy-0000' })
    expect(await app.call('models.list')).toEqual([...anthropic, { provider: 'openai-codex', modelId: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', description: 'Use GPT as the main agent instead.' }])
    await app.quit()
  }, 30_000)

  test('list offers an OpenCode Go sign-in its own short list, so that sign-in alone never gets an empty picker', async () => {
    const where = scratch()
    const app = await start(where, 'models')
    await app.call('auth.setKey', { provider: 'opencode-go', key: 'sk-test-dummy-0000' })
    expect(await app.call('models.list')).toEqual([
      { provider: 'opencode-go', modelId: 'glm-5.3', name: 'GLM 5.3', description: 'An open model on your OpenCode Go plan.' },
      { provider: 'opencode-go', modelId: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', description: 'An open model on your OpenCode Go plan.' },
    ])
    await app.quit()
  }, 30_000)
})
