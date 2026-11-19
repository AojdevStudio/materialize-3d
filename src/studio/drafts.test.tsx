// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
const { invokeMock, listeners } = vi.hoisted(() => ({ invokeMock: vi.fn(), listeners: [] as Listener[] }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_: string, listener: Listener) => {
    listeners.push(listener)
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve() }))

import { type AppState, type Project, type SavedDraft, START } from '../../sidecar/src/protocol'
import { savedAttachment } from './Composer'
import { type Clock, createDrafts } from './drafts'
import { useStudio, useStudioEvents } from './store'

// jsdom has no object URLs for the previews of pasted pictures.
URL.createObjectURL = vi.fn(() => 'blob:preview')
URL.revokeObjectURL = vi.fn()

const clock: Clock = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
}

const projectA: Project = { id: '2026-11-06-a', conversation: 2, title: 'Project A', createdMs: 2 }
const projectB: Project = { id: '2026-11-06-b', conversation: 3, title: 'Project B', createdMs: 1 }
/** The project a send from the start screen makes. */
const made: Project = { id: '2026-11-06-a-clip', conversation: 10, title: 'A clip', createdMs: 10 }

const LOST = 'The engine restarted before it answered. Try again.'

type Params = Record<string, unknown>
type Answer = (params: Params) => Promise<unknown>

/** The revision the mocked sidecar gives the newest save. */
let revs = 0
let calls: { method: string; params: Params }[] = []

/**
 * The sidecar's answers to what the drafts ask, by method. A save answers a new revision, and a send answers the
 * project it went to. The sidecar's own draft and send rules are the sidecar tests' job, so none are copied here.
 */
const defaults: Record<string, Answer> = {
  'drafts.set': () => Promise.resolve({ rev: ++revs }),
  'chat.send': ({ key }) => Promise.resolve({ project: key === START ? made : [projectA, projectB].find((p) => p.id === key) }),
  'chat.open': ({ project }) => Promise.resolve({ project, entries: [], running: false, waiting: null, turn: null, seq: 1 }),
  'drafts.picture': ({ name }) => Promise.resolve(`/state/pictures/1/${String(name)}`),
  'projects.status': () => Promise.resolve({}),
  'setup.check': () => Promise.resolve([]),
  'models.list': () => Promise.resolve([]),
}

/** Holds each call until `release`, then answers as the sidecar would. */
function held(method: string) {
  let release = () => {}
  return {
    answer: (params: Params) => new Promise((resolve) => (release = () => resolve(defaults[method](params)))),
    release: () => step(() => release()),
  }
}

/** A send whose first answer is lost, as when the engine restarts. Later sends answer. */
function lostOnce(): Answer {
  let tries = 0
  return (params) => (tries++ === 0 ? Promise.reject(LOST) : defaults['chat.send'](params))
}

/** Lets the sidecar's answers land, and `ms` pass on the fake clock. */
const step = (action: () => unknown = () => {}, ms = 0) =>
  act(async () => {
    action()
    await vi.advanceTimersByTimeAsync(ms)
  })
const pass = (ms: number) => step(() => {}, ms)

function Window() {
  useStudioEvents([])
  return null
}

/** Opens a window on the mocked sidecar, and its drafts. `sent` lists each project a send went to. */
function open(answers: Record<string, Answer> = {}) {
  invokeMock.mockImplementation((command: string, { method, params = {} }: { method?: string; params?: Params } = {}) => {
    if (command !== 'sidecar' || method === undefined) return Promise.resolve([])
    calls.push({ method, params })
    const answer = answers[method] ?? defaults[method]
    return answer === undefined ? Promise.resolve(null) : answer(params)
  })
  const window = render(<Window />)
  const sent: Project[] = []
  const drafts = createDrafts(clock, (project) => sent.push(project))
  const shown = () => drafts.state.getState().shown
  return {
    drafts,
    sent,
    shown,
    window,
    go: (project: Project | null) => step(() => (project === null ? drafts.show(null) : drafts.open(project))),
    type: (text: string) => step(() => drafts.type(text)),
    attach: (...paths: string[]) => step(() => drafts.attach(paths)),
    remove: (path: string) => step(() => drafts.remove(savedAttachment(path), shown().attachments.indexOf(path))),
    paste: (file: File) => step(() => drafts.paste([{ name: file.name, file }])),
    send: () => step(() => void drafts.send()),
    take: (saved: Record<string, SavedDraft>) => step(() => drafts.take({ ...STATE, drafts: saved })),
    quit: () => {
      const quitting = { done: false, failed: undefined as unknown }
      void drafts.quit().then(
        () => (quitting.done = true),
        (err: unknown) => (quitting.failed = err),
      )
      return quitting
    },
  }
}

const STATE: AppState = {
  setup: { step: 'ready', done: true },
  settings: { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, thinking: 'high', printer: { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PETG Basic @BBL P2S' }, astra: false },
  projects: [projectA, projectB],
  drafts: {},
  importBlocked: null,
}

const of = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params)
const saves = (key?: string) => of('drafts.set').filter((save) => key === undefined || save.key === key)
const sends = () => of('chat.send')
const last = <T,>(items: T[]) => items[items.length - 1]
const engineReady = () => step(() => listeners.forEach((listener) => listener({ payload: { type: 'ready', version: '0.3.2' } })))
const shot = () => new File(['png'], 'shot.png', { type: 'image/png' })

beforeEach(() => {
  vi.useFakeTimers()
  revs = 0
  calls = []
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  invokeMock.mockReset()
  listeners.length = 0
})

it('saves the open screen once typing pauses, and each key press starts the pause again', async () => {
  const { type, shown } = open()

  await type('A cable')
  await pass(399)
  await type('A cable clip')
  await pass(399)
  expect(saves()).toEqual([])

  await pass(1)
  expect(saves()).toEqual([{ key: START, text: 'A cable clip', attachments: [] }])
  expect(shown().text).toBe('A cable clip')
})

it('saves a draft at once when the person moves to another project', async () => {
  const { go, type } = open()
  await go(projectB)
  await type('make it blue')
  await go(projectA)
  expect(saves()).toEqual([{ key: projectB.id, text: 'make it blue', attachments: [] }])
})

it('fills the composer with a saved draft when its project opens, and saves a change to it', async () => {
  const { go, type, take, shown } = open()
  await take({ [projectB.id]: { text: 'make it red', attachments: ['/Users/me/photo.jpg'], rev: 1 } })
  await go(projectB)
  expect(shown()).toEqual({ text: 'make it red', attachments: ['/Users/me/photo.jpg'] })
  await type('make it blue')
  await pass(400)
  expect(saves()).toEqual([{ key: projectB.id, text: 'make it blue', attachments: ['/Users/me/photo.jpg'] }])
})

it('saves a picture-only draft', async () => {
  const { go, attach } = open()
  await go(projectB)
  await attach('/Users/me/photo.jpg')
  await pass(400)
  expect(saves()).toEqual([{ key: projectB.id, text: '', attachments: ['/Users/me/photo.jpg'] }])
})

it('sends the revision the draft was saved as, and names nothing else', async () => {
  const { go, type, send } = open()
  await go(projectB)
  await type('Make it red')
  await send()
  expect(sends()).toEqual([{ key: projectB.id, rev: revs }])
})

it('sends again after a lost answer under the same revision, with no new save', async () => {
  const { drafts, go, attach, type, send } = open({ 'chat.send': lostOnce() })
  await go(projectB)
  await attach('/Users/me/photo.jpg')
  await type('A clip like this')
  await send()
  expect(drafts.state.getState().sendErrors).toEqual({ [projectB.id]: LOST })
  await send()
  expect(sends()).toHaveLength(2)
  expect(sends()[1]).toEqual(sends()[0])
  expect(saves()).toEqual([{ key: projectB.id, text: 'A clip like this', attachments: ['/Users/me/photo.jpg'] }])
  expect(drafts.state.getState().sendErrors).toEqual({})
})

it("keeps a slow send's failure with the project it was sent to, and sending again names the same revision", async () => {
  let fail = (_: string) => {}
  let tries = 0
  const { drafts, go, type, send } = open({ 'chat.send': (params) => (++tries === 1 ? new Promise((_, reject) => (fail = reject)) : defaults['chat.send'](params)) })
  await go(projectA)
  await type('A clip for my desk')
  await send()
  await go(projectB)
  await step(() => fail(LOST))
  expect(drafts.state.getState().sendErrors).toEqual({ [projectA.id]: LOST })
  expect(useStudio.getState().error).toBeNull()

  await go(projectA)
  await send()
  expect(sends()[1]).toEqual(sends()[0])
  expect(saves()).toHaveLength(1)
  expect(drafts.state.getState().sendErrors).toEqual({})
})

it("keeps each project's unsent message, so sending it again after another project's send names its revision", async () => {
  let tries = 0
  const { go, type, send, shown } = open({ 'chat.send': (params) => (++tries === 1 ? Promise.reject(LOST) : defaults['chat.send'](params)) })
  await go(projectA)
  await type('A clip for my desk')
  await send()
  await go(projectB)
  await type('make it blue')
  await send()
  await go(projectA)
  expect(shown().text).toBe('A clip for my desk')
  await send()
  const [first, , third] = sends()
  expect(third).toEqual(first)
  expect(saves(projectA.id)).toHaveLength(1)
})

it('leaves the project the person moved to alone when a slow send from the start screen finishes', async () => {
  const sending = held('chat.send')
  const { sent, go, type, send, shown } = open({ 'chat.send': sending.answer })
  await type('A clip for my desk')
  await send()
  expect(sends()).toEqual([{ key: START, rev: 1 }])
  await go(projectB)
  await type('draft for B')

  await sending.release()
  expect(sent).toEqual([made])
  expect(useStudio.getState().current).toEqual(projectB)
  expect(shown().text).toBe('draft for B')
})

it('drops a sent start picture when a paste lands after the person leaves during the send', async () => {
  const sending = held('chat.send')
  const keeping = held('drafts.picture')
  const { go, attach, type, paste, send, shown } = open({
    'chat.send': sending.answer,
    'drafts.picture': keeping.answer,
  })
  await attach('/Users/me/sent.jpg')
  await type('A clip')
  await send()
  await paste(shot())
  await go(projectB)
  await keeping.release()
  await sending.release()

  const next = { text: 'A clip', attachments: ['/state/pictures/1/shot.png'] }
  expect(last(saves(START))).toEqual({ key: START, ...next })
  await go(null)
  expect(shown()).toEqual(next)
})

it('never brings a sent picture back in the next draft', async () => {
  const sending = held('chat.send')
  const { go, attach, type, send, shown } = open({ 'chat.send': sending.answer })
  await go(projectB)
  await attach('/Users/me/photo.jpg')
  await type('Like this')
  await send()
  await type('And thinner')
  await sending.release()
  await pass(400)
  expect(last(saves())).toEqual({ key: projectB.id, text: 'And thinner', attachments: [] })
  await go(projectA)
  await go(projectB)
  expect(shown().attachments).toEqual([])
})

it("leaves another project's same picture alone when a send goes through", async () => {
  const sending = held('chat.send')
  const { go, attach, type, send } = open({ 'chat.send': sending.answer })
  await go(projectA)
  await attach('/Users/me/photo.jpg')
  await type('Like this')
  await send()
  await go(projectB)
  await attach('/Users/me/photo.jpg')
  await sending.release()
  await pass(400)
  expect(last(saves(projectB.id))).toEqual({ key: projectB.id, text: '', attachments: ['/Users/me/photo.jpg'] })
})

it('takes the sent pictures out of the composer when the person left and came back before the send went through', async () => {
  const sending = held('chat.send')
  const { go, attach, type, send, shown } = open({ 'chat.send': sending.answer })
  await go(projectA)
  await attach('/Users/me/photo.jpg')
  await type('Like this')
  await send()
  await go(projectB)
  await go(projectA)
  await sending.release()
  expect(shown().attachments).toEqual([])
})

it('keeps the next picture when Remove runs twice for the same row', async () => {
  const { drafts, go, attach, shown } = open()
  await go(projectA)
  const first = '/Users/me/first.jpg'
  const second = '/Users/me/second.jpg'
  await attach(first, second, first)
  const row = drafts.state.getState().attachments[0]

  await step(() => {
    drafts.remove(row, 0)
    drafts.remove(row, 0)
  }, 400)

  expect(shown().attachments).toEqual([second, first])
  expect(last(saves(projectA.id))).toEqual({ key: projectA.id, text: '', attachments: [second, first] })
})

it('keeps a picture the person took out and put back while its send was on its way', async () => {
  const sending = held('chat.send')
  const { go, take, remove, attach, send, shown } = open({ 'chat.send': sending.answer })
  await take({ [projectA.id]: { text: 'A clip like this', attachments: ['/Users/me/pic.jpg'], rev: 7 } })
  await go(projectA)
  await send()
  await remove('/Users/me/pic.jpg')
  await attach('/Users/me/pic.jpg')
  await sending.release()
  expect(shown().attachments).toEqual(['/Users/me/pic.jpg'])
})

it('keeps a newer draft that reads the same as the sent text, with a picture added during the send', async () => {
  const sending = held('chat.send')
  const { go, type, attach, send, shown } = open({ 'chat.send': sending.answer })
  await go(projectB)
  await type('Make it red')
  await send()
  await type('Make it blue')
  await type('Make it red')
  await attach('/Users/me/new.jpg')
  await pass(400)
  await sending.release()
  await go(projectA)
  await go(projectB)
  expect(shown()).toEqual({ text: 'Make it red', attachments: ['/Users/me/new.jpg'] })
  expect(last(saves(projectB.id))).toEqual({ key: projectB.id, ...shown() })
})

it('keeps the composer and the saved draft the same when a picture was added during a send', async () => {
  const sending = held('chat.send')
  const { go, type, attach, send, shown } = open({ 'chat.send': sending.answer })
  await go(projectB)
  await type('Make it red')
  await send()
  await attach('/Users/me/new.jpg')
  await pass(400)
  await sending.release()
  const next = { text: 'Make it red', attachments: ['/Users/me/new.jpg'] }
  expect(shown()).toEqual(next)
  expect(last(saves(projectB.id))).toEqual({ key: projectB.id, ...next })
  await go(projectA)
  await go(projectB)
  expect(shown()).toEqual(next)
})

it('keeps text typed during a send as the next message, even when it reads the same as the sent one', async () => {
  const sending = held('chat.send')
  const { go, type, send, shown } = open({ 'chat.send': sending.answer })
  await go(projectB)
  await type('Make it red')
  await send()
  await type('Make it blue')
  await type('Make it red')
  await sending.release()
  expect(shown().text).toBe('Make it red')
})

it('keeps text typed while a send goes through as the draft', async () => {
  const sending = held('chat.send')
  const { go, type, send, shown } = open({ 'chat.send': sending.answer })
  await go(projectB)
  await type('make it red')
  await send()
  await type('make it blue')
  await sending.release()
  await go(projectA)
  await go(projectB)
  expect(shown().text).toBe('make it blue')
})

it("clears a sent project's draft even when the person typed in another project meanwhile", async () => {
  const sending = held('chat.send')
  const { go, type, send, shown } = open({ 'chat.send': sending.answer })
  await go(projectB)
  await type('Make it red')
  await send()
  await go(projectA)
  await type('something for A')
  await sending.release()
  await go(projectB)
  expect(shown().text).toBe('')
})

it('keeps a pasted picture on the screen it was pasted on, even when the person leaves before it is kept', async () => {
  const keeping = held('drafts.picture')
  const { go, paste, shown } = open({ 'drafts.picture': keeping.answer })
  await go(projectA)
  await paste(shot())
  expect(of('drafts.picture')).toHaveLength(1)
  await go(projectB)
  await keeping.release()
  expect(shown().attachments).toEqual([])
  expect(saves()).toContainEqual({ key: projectA.id, text: '', attachments: ['/state/pictures/1/shot.png'] })
  await go(projectA)
  expect(shown().attachments).toEqual(['/state/pictures/1/shot.png'])
})

it("keeps a paste that lands after the person left in that screen's draft, beside the text typed there", async () => {
  const keeping = held('drafts.picture')
  const { go, type, paste, shown } = open({ 'drafts.picture': keeping.answer })
  await go(projectA)
  await type('like this')
  await paste(shot())
  await go(projectB)
  await keeping.release()
  expect(last(saves(projectA.id))).toEqual({ key: projectA.id, text: 'like this', attachments: ['/state/pictures/1/shot.png'] })
  await go(projectA)
  expect(shown()).toEqual({ text: 'like this', attachments: ['/state/pictures/1/shot.png'] })
})

it('keeps a paste on its screen even when the person leaves while its bytes are read', async () => {
  const { go, paste, shown } = open()
  await go(projectA)
  let finishRead = (_: ArrayBuffer) => {}
  const file = shot()
  file.arrayBuffer = () => new Promise((resolve) => (finishRead = resolve))
  await paste(file)
  await go(projectB)
  await step(() => finishRead(new ArrayBuffer(3)))
  expect(shown().attachments).toEqual([])
  expect(last(saves(projectA.id))).toEqual({ key: projectA.id, text: '', attachments: ['/state/pictures/1/shot.png'] })
})

it("brings the start screen's saved pictures back when the person typed before the saved state arrived", async () => {
  const { type, take, shown } = open()
  await type('a hook')
  await take({ [START]: { text: 'older', attachments: ['/Users/me/hook.jpg'], rev: 1 } })
  expect(shown()).toEqual({ text: 'a hook', attachments: ['/Users/me/hook.jpg'] })
  await pass(400)
  expect(last(saves())).toEqual({ key: START, text: 'a hook', attachments: ['/Users/me/hook.jpg'] })
})

it("brings the start screen's saved pictures back when the person typed and paused before the saved state arrived", async () => {
  const { type, take, shown } = open()
  await type('a hook')
  await pass(400)
  await take({ [START]: { text: 'older', attachments: ['/Users/me/hook.jpg'], rev: 1 } })
  expect(shown().attachments).toEqual(['/Users/me/hook.jpg'])
  expect(last(saves())).toEqual({ key: START, text: 'a hook', attachments: ['/Users/me/hook.jpg'] })
})

it('keeps what the person typed on the start screen when the saved state arrives', async () => {
  const { type, take, shown } = open()
  await type('A clip for my desk')
  await take({ [START]: { text: 'an older draft', attachments: [], rev: 1 } })
  expect(shown().text).toBe('A clip for my desk')
})

it('leaves the start screen empty when the person cleared it before the saved state arrived', async () => {
  const { type, take, shown } = open()
  await type('A clip for my desk')
  await type('')
  await take({ [START]: { text: 'an older draft', attachments: [], rev: 1 } })
  expect(shown().text).toBe('')
})

it('sends a start picture the saved state brings back with the text typed before it came', async () => {
  const { type, take, send, shown } = open()
  await type('A clip')
  await take({ [START]: { text: '', attachments: ['/Users/me/a.jpg'], rev: 1 } })
  expect(shown().attachments).toEqual(['/Users/me/a.jpg'])
  await send()
  expect(last(saves())).toEqual({ key: START, text: 'A clip', attachments: ['/Users/me/a.jpg'] })
  expect(sends()).toEqual([{ key: START, rev: revs }])
})

it('sends pictures restored by moving away and back as the same message: the same revision, with no new save', async () => {
  const { go, take, send, shown } = open({ 'chat.send': lostOnce() })
  await take({ [projectA.id]: { text: 'A clip like this', attachments: ['/Users/me/pic.jpg'], rev: 7 } })
  await go(projectA)
  await send()
  await go(projectB)
  await go(projectA)
  expect(shown().text).toBe('A clip like this')
  await send()
  expect(sends()).toEqual([
    { key: projectA.id, rev: 7 },
    { key: projectA.id, rev: 7 },
  ])
  expect(saves()).toEqual([])
})

it('sends a picture taken out and put back as a new message, under a new revision', async () => {
  const { go, take, remove, attach, send } = open({ 'chat.send': lostOnce() })
  await take({ [projectA.id]: { text: 'A clip like this', attachments: ['/Users/me/pic.jpg'], rev: 7 } })
  await go(projectA)
  await send()
  await remove('/Users/me/pic.jpg')
  await attach('/Users/me/pic.jpg')
  await send()
  expect(last(saves())).toEqual({ key: projectA.id, text: 'A clip like this', attachments: ['/Users/me/pic.jpg'] })
  expect(sends()[1]).toEqual({ key: projectA.id, rev: revs })
  expect(revs).not.toBe(7)
})

it('fails a send whose draft save fails, and sends nothing under the older revision', async () => {
  let tries = 0
  const { drafts, go, type, send } = open({
    'chat.send': lostOnce(),
    'drafts.set': (params) => (++tries === 2 || tries === 3 ? Promise.reject('The engine is starting.') : defaults['drafts.set'](params)),
  })
  await go(projectA)
  await type('A clip for my desk')
  await send()
  await type('A clip for my shelf')
  // The pause after typing saves the change, and that save fails. So does the one the send makes.
  await pass(400)
  await send()
  expect(saves().slice(1, 3)).toEqual([
    { key: projectA.id, text: 'A clip for my shelf', attachments: [] },
    { key: projectA.id, text: 'A clip for my shelf', attachments: [] },
  ])
  expect(sends()).toHaveLength(1)
  expect(drafts.state.getState().sendErrors).toEqual({ [projectA.id]: 'The engine is starting.' })
  await send()
  expect(last(saves())).toEqual({ key: projectA.id, text: 'A clip for my shelf', attachments: [] })
  expect(sends()[1]).toEqual({ key: projectA.id, rev: revs })
})

it('never saves one screen twice at once when Send comes while an autosave is on its way, and sends an unchanged message once', async () => {
  const saving = held('drafts.set')
  const { go, type, send } = open({ 'drafts.set': saving.answer })
  await go(projectB)
  await type('Make it red')
  await pass(400)
  await send()
  expect(saves()).toHaveLength(1)
  await saving.release()
  expect(sends()).toEqual([{ key: projectB.id, rev: revs }])
  await pass(400)
  expect(saves()).toHaveLength(1)
})

it('sends the message the person clicked Send on, even when they type more while an earlier autosave is still on its way', async () => {
  let releaseFirst = () => {}
  let tries = 0
  const { go, type, send, shown } = open({
    'drafts.set': (params) => (++tries === 1 ? new Promise((resolve) => (releaseFirst = () => resolve(defaults['drafts.set'](params)))) : defaults['drafts.set'](params)),
  })
  await go(projectB)
  await type('Make it red')
  await pass(400)
  await send()
  await type('Make it blue')
  await step(() => releaseFirst())
  expect(sends()).toEqual([{ key: projectB.id, rev: 1 }])
  expect(saves()[0]).toMatchObject({ text: 'Make it red' })
  // The text typed after the click is the next message: it stays in the composer, and it is saved.
  await pass(400)
  expect(shown().text).toBe('Make it blue')
  expect(last(saves())).toEqual({ key: projectB.id, text: 'Make it blue', attachments: [] })
})

it('keeps text typed while the draft before a send was still being saved, and saves it once the send is done', async () => {
  const saving = held('drafts.set')
  let tries = 0
  const { go, type, send, shown } = open({ 'drafts.set': (params) => (++tries === 1 ? saving.answer(params) : defaults['drafts.set'](params)) })
  await go(projectB)
  await type('Make it red')
  await send()
  await type('Make it blue')
  await pass(500)
  expect(saves()).toHaveLength(1)
  await saving.release()
  expect(sends()).toEqual([{ key: projectB.id, rev: 1 }])
  expect(last(saves())).toEqual({ key: projectB.id, text: 'Make it blue', attachments: [] })
  expect(shown().text).toBe('Make it blue')
})

it('leaves the start screen empty after its message was sent, and takes the person to its project', async () => {
  const { sent, go, type, send, shown } = open()
  await type('A clip for my desk')
  await pass(400)
  await send()
  expect(sent).toEqual([made])
  expect(useStudio.getState().current).toEqual(made)
  expect(shown().text).toBe('')
  await go(null)
  expect(shown().text).toBe('')
})

it('takes a picture-only first message to its project and saves nothing more on the start screen', async () => {
  const { go, attach, send, shown } = open()
  await attach('/Users/me/photo.jpg')
  await send()
  expect(useStudio.getState().current).toEqual(made)
  expect(shown().attachments).toEqual([])
  await go(null)
  expect(shown().attachments).toEqual([])
  await pass(400)
  expect(saves()).toEqual([{ key: START, text: '', attachments: ['/Users/me/photo.jpg'] }])
})

it('clears a picture-only first message from the start screen the person went back to', async () => {
  const sending = held('chat.send')
  const { go, attach, send, shown } = open({ 'chat.send': sending.answer })
  await attach('/Users/me/photo.jpg')
  await send()
  await go(projectB)
  await go(null)
  await sending.release()
  expect(useStudio.getState().current).toEqual(made)
  await go(null)
  expect(shown().attachments).toEqual([])
})

it('sends a picture-only first message again after a lost answer to the same project, once', async () => {
  const { sent, go, attach, send, shown } = open({ 'chat.send': lostOnce() })
  await attach('/Users/me/pic.jpg')
  await send()
  expect(useStudio.getState().error).toBe(LOST)
  await go(projectB)
  await go(null)
  expect(shown().attachments).toEqual(['/Users/me/pic.jpg'])
  await send()
  expect(sends()).toHaveLength(2)
  expect(sends()[1]).toEqual(sends()[0])
  expect(saves()).toHaveLength(1)
  expect(sent).toEqual([made])
  expect(useStudio.getState().current).toEqual(made)
})

it('leaves no draft behind when the person left the start screen before its first send finished', async () => {
  const sending = held('chat.send')
  const { go, type, send, shown } = open({ 'chat.send': sending.answer })
  await type('A clip')
  await send()
  await go(projectB)
  await sending.release()
  await pass(400)
  expect(saves()).toEqual([{ key: START, text: 'A clip', attachments: [] }])
  await go(null)
  expect(shown().text).toBe('')
})

it('keeps text edited during a first send in the start draft and drops the sent picture', async () => {
  const sending = held('chat.send')
  const { go, attach, type, send, shown } = open({ 'chat.send': sending.answer })
  await attach('/Users/me/photo.jpg')
  await type('A clip')
  await send()
  await type('A hook')
  await go(projectB)
  expect(saves(START)).toEqual([{ key: START, text: 'A clip', attachments: ['/Users/me/photo.jpg'] }])
  await sending.release()
  expect(last(saves(START))).toEqual({ key: START, text: 'A hook', attachments: [] })
  expect(saves(made.id)).toEqual([])
  expect(sends()).toHaveLength(1)
  await go(null)
  expect(shown()).toEqual({ text: 'A hook', attachments: [] })
})

it("keeps text typed during a first send as its project's draft, and never saves it on the start screen", async () => {
  const sending = held('chat.send')
  const { go, type, send, shown } = open({ 'chat.send': sending.answer })
  await type('A clip for my desk')
  await send()
  await type('second message')
  await pass(400)
  await sending.release()
  expect(saves(made.id)).toEqual([{ key: made.id, text: 'second message', attachments: [] }])
  expect(saves(START)).toEqual([{ key: START, text: 'A clip for my desk', attachments: [] }])
  await go(projectB)
  await go(made)
  expect(shown().text).toBe('second message')
})

it("keeps a picture added while a first message was on its way, as its project's draft", async () => {
  const sending = held('chat.send')
  const { attach, type, send, shown } = open({ 'chat.send': sending.answer })
  await type('A clip')
  await send()
  await attach('/Users/me/later.jpg')
  await sending.release()
  expect(useStudio.getState().current).toEqual(made)
  expect(shown().attachments).toEqual(['/Users/me/later.jpg'])
  expect(saves(made.id)).toEqual([{ key: made.id, text: 'A clip', attachments: ['/Users/me/later.jpg'] }])
})

it('never puts a sent message back on the start screen when text typed during it was taken back', async () => {
  const sending = held('chat.send')
  const { go, type, send, shown } = open({ 'chat.send': sending.answer })
  await type('A clip for my desk')
  await send()
  await type('A clip for my desk, and')
  await type('A clip for my desk')
  await sending.release()
  await pass(400)
  expect(saves(START)).toEqual([{ key: START, text: 'A clip for my desk', attachments: [] }])
  await go(null)
  expect(shown().text).toBe('')
})

it('saves a draft the engine refused at quit again as soon as the engine is back', async () => {
  let refuse = true
  const { type, quit } = open({ 'drafts.set': (params) => (refuse ? Promise.reject(new Error('The engine is restarting')) : defaults['drafts.set'](params)) })
  await type('A cable clip')

  const quitting = quit()
  await pass(0)
  expect(saves()).toEqual([{ key: START, text: 'A cable clip', attachments: [] }])
  expect(quitting.done).toBe(false)

  refuse = false
  await engineReady()
  expect(saves()).toHaveLength(2)
  expect(quitting.done).toBe(true)
})

it('tries a refused save again each pause, and calls the quit off when the last try fails', async () => {
  const { type, quit } = open({ 'drafts.set': () => Promise.reject(new Error('The engine is restarting')) })
  await type('A cable clip')

  const quitting = quit()
  await pass(2999)
  expect(saves()).toHaveLength(1)
  await pass(1)
  expect(saves()).toHaveLength(2)

  await pass(2 * 3000)
  expect(saves()).toHaveLength(4)
  expect(quitting.failed).toEqual(new Error('a draft could not be saved'))
  expect(useStudio.getState().error).toBe('A draft could not be saved, so Materialize 3D stayed open. Quit again once the engine is back.')
})

it('saves every screen before a quit goes on, retrying a save the engine restart refused once the engine is back', async () => {
  let engineBack = false
  const savingB = held('drafts.set')
  const { go, type, quit } = open({
    'drafts.set': (params) => {
      if (params.key === projectA.id && !engineBack) return Promise.reject(LOST)
      if (params.key === projectB.id) return savingB.answer(params)
      return defaults['drafts.set'](params)
    },
  })
  await go(projectA)
  await type('a hook')
  await go(projectB)
  await type('a shelf')
  const quitting = quit()
  await pass(0)
  await savingB.release()
  expect(quitting.done).toBe(false)
  const refused = saves(projectA.id).length
  engineBack = true
  await engineReady()
  expect(quitting.done).toBe(true)
  expect(saves(projectA.id)).toHaveLength(refused + 1)
  expect(last(saves(projectA.id))).toMatchObject({ text: 'a hook' })
  expect(last(saves(projectB.id))).toMatchObject({ text: 'a shelf' })
})

it('saves text typed during a send that started while a quit waited to retry, before the quit goes on', async () => {
  let engineBack = false
  const sending = held('chat.send')
  const { go, type, send, quit } = open({
    'drafts.set': (params) => (engineBack ? defaults['drafts.set'](params) : Promise.reject(LOST)),
    'chat.send': sending.answer,
  })
  await go(projectA)
  await type('a hook')
  const quitting = quit()
  await pass(0)
  // The engine is back before its ready event reaches the window. The person sends, then types the next message.
  engineBack = true
  await send()
  expect(sends()).toHaveLength(1)
  await type('a hook, in black')
  await engineReady()
  expect(quitting.done).toBe(false)
  await sending.release()
  expect(quitting.done).toBe(true)
  expect(last(saves(projectA.id))).toMatchObject({ text: 'a hook, in black' })
})

it('saves text typed during a send clicked while the quit waited for a save already on its way', async () => {
  const saving = held('drafts.set')
  const sending = held('chat.send')
  let tries = 0
  const { go, type, send, quit } = open({
    'drafts.set': (params) => (++tries === 1 ? saving.answer(params) : defaults['drafts.set'](params)),
    'chat.send': sending.answer,
  })
  await go(projectA)
  await type('a hook')
  // The pause after typing starts the save, and the quit comes while it is on its way.
  await pass(400)
  const quitting = quit()
  await pass(0)
  await send()
  await type('a hook, in black')
  await saving.release()
  expect(quitting.done).toBe(false)
  await sending.release()
  expect(quitting.done).toBe(true)
  expect(last(saves(projectA.id))).toMatchObject({ text: 'a hook, in black' })
})

it('waits for a draft save already on its way before it says a quit may go on', async () => {
  const saving = held('drafts.set')
  const { go, type, quit } = open({ 'drafts.set': saving.answer })
  await go(projectB)
  await type('half a thought')
  await pass(400)
  expect(saves()).toHaveLength(1)
  const quitting = quit()
  await pass(0)
  expect(quitting.done).toBe(false)
  await saving.release()
  expect(quitting.done).toBe(true)
})

it('waits for a pasted picture still being kept before it says a quit may go on, and saves it with the draft', async () => {
  const keeping = held('drafts.picture')
  const { go, paste, quit } = open({ 'drafts.picture': keeping.answer })
  await go(projectA)
  await paste(shot())
  const quitting = quit()
  await pass(0)
  expect(quitting.done).toBe(false)
  await keeping.release()
  expect(quitting.done).toBe(true)
  expect(last(saves(projectA.id))).toMatchObject({ attachments: ['/state/pictures/1/shot.png'] })
})

it('saves the draft a first send made for its project during a quit before it says the quit may go on', async () => {
  const sending = held('chat.send')
  const { type, send, quit } = open({ 'chat.send': sending.answer })
  await type('A knob')
  await send()
  await type('A knob, and a dial')
  const quitting = quit()
  await sending.release()
  expect(quitting.done).toBe(true)
  expect(last(saves(made.id))).toEqual({ key: made.id, text: 'A knob, and a dial', attachments: [] })
})
