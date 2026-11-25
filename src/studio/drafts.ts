import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { type AppState, type Draft, type ModelChoice, type Project, START } from '../../sidecar/src/protocol'
import { onFileDrop, onQuitFlush, sidecar } from './api'
import { releaseAttachment, savedAttachment, type Attachment, type PastedPicture } from './Composer'
import { checkReady, load, onNextReady, retry, setError, show as showProject, start, useStudio } from './store'

const DRAFT_PAUSE_MS = 400
const QUIT_SAVE_TRIES = 4
const QUIT_RETRY_MS = 3000

const EMPTY: Draft = { text: '', attachments: [] }

/** Runs `run` once `ms` pass, and answers what cancels it. Tests hand in fake timers. */
export type Clock = { after: (ms: number, run: () => void) => () => void }

const windowClock: Clock = {
  after: (ms, run) => {
    const timer = window.setTimeout(run, ms)
    return () => window.clearTimeout(timer)
  },
}

/**
 * A screen's unsent message as the window holds it. The sidecar owns the draft and the send: the window only knows
 * whether the screen changed since its last completed save, and that save's revision, which a send names.
 */
type Screen = {
  draft: Draft
  /** The last save that completed: the draft it saved, and its revision. None while the store holds no draft. */
  saved?: { draft: Draft; rev: number }
  saving?: Promise<void>
  /** Nothing else saves the screen while its send is on its way, as that would replace the draft it sends. */
  sending?: Promise<void>
  /**
   * The pictures that send carries, but for any the person took out since. A sent picture leaves the next draft when
   * the send goes through, unless the person took it out and chose it again.
   */
  sendingPictures?: Set<string>
}

/** What the open screen's composer shows, and the sends that failed, by project. */
type Shown = { shown: Draft; attachments: Attachment[]; sending: boolean; sendErrors: Record<string, string> }

/** Each change makes a new draft object. */
const changed = (screen: Screen) => screen.draft !== (screen.saved?.draft ?? EMPTY)

/** A pasted picture's bytes as base64, to cross the sidecar's pipe. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * The window's drafts and sends: each screen it changed or filled from the saved state, by project id, or `START` for
 * the start screen. Typing saves its screen once typing pauses, and at once when the person leaves it. A send saves
 * first if the screen changed, then names the revision. A draft keeps its pictures as the paths of their files.
 * `onSent` hears each project a send went to.
 */
export function createDrafts(clock: Clock, onSent: (project: Project) => void) {
  const state = createStore<Shown>()(() => ({ shown: EMPTY, attachments: [], sending: false, sendErrors: {} }))
  const screens: Record<string, Screen> = {}
  let pending: { key: string; cancel: () => void } | null = null
  /** Pastes whose pictures are still being kept, so a quit waits for them. */
  const pastes = new Set<Promise<void>>()
  /** The previews of pasted pictures, by path, freed when the window closes. */
  const previews = new Map<string, string>()
  /** A second click can use the same row before the composer redraws. */
  const removedRows = new WeakSet<Attachment>()
  /** Whether the person changed the start screen's pictures, so its saved ones no longer fill it. */
  let startPicturesTouched = false

  const openKey = () => useStudio.getState().current?.id ?? START
  const draftOf = (key: string) => screens[key]?.draft ?? EMPTY

  const setShown = (shown: Draft) =>
    state.setState({ shown, attachments: shown.attachments.map((path) => ({ ...savedAttachment(path), previewUrl: previews.get(path) })) })

  const put = (key: string, draft: Draft) => {
    ;(screens[key] ??= { draft }).draft = draft
    if (key === openKey()) setShown(draft)
  }

  /** Empties a screen whose draft the store no longer holds. */
  const clear = (key: string) => {
    put(key, EMPTY)
    delete screens[key].saved
  }

  /**
   * Saves a screen until the store holds what it shows, one save at a time: a save wanted while one runs waits for it,
   * then saves the newest draft. While the screen's send is on its way, only that send saves it, and it saves `going`,
   * the draft taken at the click, so text typed while an earlier save finished stays the next message. Answers the last
   * completed save.
   */
  const flush = async (key: string, going?: Draft) => {
    const screen = screens[key]
    if (screen === undefined) return undefined
    while (screen.saving !== undefined) await screen.saving
    const wanted = going === undefined ? (screen.sending === undefined && changed(screen) ? screen.draft : undefined) : going
    if (wanted !== undefined && wanted !== screen.saved?.draft) {
      const draft = wanted
      const save = sidecar('drafts.set', { key, ...draft }).then(({ rev }) => {
        screen.saved = { draft, rev }
      })
      const done = () => {
        screen.saving = undefined
      }
      screen.saving = save.then(done, done)
      await save
    }
    return screen.saved
  }

  const autosave = (key: string) => void flush(key).catch((err: unknown) => setError(String(err)))

  const clearPause = () => {
    pending?.cancel()
    pending = null
  }

  const edit = (key: string, draft: Draft) => {
    put(key, draft)
    clearPause()
    const cancel = clock.after(DRAFT_PAUSE_MS, () => {
      pending = null
      autosave(key)
    })
    pending = { key, cancel }
  }

  /** The open screen saves once typing pauses. Another screen, which a paste lands on after the person left, saves at once. */
  const setPictures = (key: string, paths: string[]) => {
    if (key === START) startPicturesTouched = true
    const going = screens[key]?.sendingPictures
    for (const path of draftOf(key).attachments) if (!paths.includes(path)) going?.delete(path)
    const draft = { ...draftOf(key), attachments: paths }
    if (key !== openKey()) {
      put(key, draft)
      autosave(key)
    } else edit(key, draft)
  }

  /** Shows a project, or the start screen, with its draft. The screen left is saved at once. */
  const show = (project: Project | null) => {
    clearPause()
    autosave(openKey())
    showProject(project)
    setShown(draftOf(openKey()))
    checkReady()
  }

  const open = (project: Project) => {
    if (project.id !== useStudio.getState().current?.id) show(project)
    else if (!retry()) return
    void load()
  }

  const attach = (paths: string[]) => setPictures(openKey(), [...draftOf(openKey()).attachments, ...paths])

  /**
   * Sends the open screen's draft by its revision: saved first if it changed, and a save that fails ends the send. The
   * sidecar makes the project for a first message, copies the pictures, and removes the draft it sent. From the start
   * screen, a `startHelper` given is the helper that project gets. Answers the project the message went to, or
   * undefined when it did not go.
   */
  const send = async (startHelper?: ModelChoice | null): Promise<Project | undefined> => {
    const key = openKey()
    const screen = screens[key]
    if (screen === undefined || (screen.draft.text.trim() === '' && screen.draft.attachments.length === 0) || state.getState().sending) return undefined
    state.setState({ sending: true })
    clearPause()
    let done = () => {}
    screen.sending = new Promise((resolve) => (done = resolve))
    try {
      screen.sendingPictures = new Set(screen.draft.attachments)
      const sent = await flush(key, screen.draft)
      if (sent === undefined) return undefined
      const helper = key === START && startHelper !== undefined ? { helper: startHelper } : {}
      const { project } = await sidecar('chat.send', { key, rev: sent.rev, ...helper })
      state.setState(({ sendErrors: { [project.id]: _, ...rest } }) => ({ sendErrors: rest }))
      onSent(project)
      // What changed since the save that went out is the next message. The pictures that went out leave it, but for one
      // the person took out and chose again during the send.
      const outgoing = screen.sendingPictures ?? new Set<string>()
      const next: Draft = { ...screen.draft, attachments: screen.draft.attachments.filter((path) => !outgoing.has(path)) }
      const unchanged = screen.draft === sent.draft
      if (key === START && openKey() === START) {
        // The person is still where the first message went from, so they go to its project, and what they changed
        // here meanwhile goes with them as its draft.
        clear(START)
        if (!unchanged) put(project.id, next)
        open(project)
        autosave(project.id)
      } else if (unchanged) {
        clear(key)
      } else if (next.attachments.length !== screen.draft.attachments.length) {
        put(key, next)
      }
      return project
    } catch (err) {
      const message = String(err)
      if (key !== START) state.setState(({ sendErrors }) => ({ sendErrors: { ...sendErrors, [key]: message } }))
      else if (openKey() === START) setError(message)
      return undefined
    } finally {
      delete screen.sending
      delete screen.sendingPictures
      done()
      state.setState({ sending: false })
      autosave(key)
    }
  }

  return {
    state,
    show,
    open,
    send,
    attach,

    type: (text: string) => edit(openKey(), { ...draftOf(openKey()), text }),

    remove: (attachment: Attachment, index: number) => {
      if (removedRows.has(attachment)) return
      const key = openKey()
      const { attachments } = draftOf(key)
      const position = attachments[index] === attachment.path ? index : attachments.indexOf(attachment.path)
      if (position === -1) return
      removedRows.add(attachment)
      const remaining = attachments.filter((_, i) => i !== position)
      if (!remaining.includes(attachment.path)) {
        releaseAttachment(attachment)
        previews.delete(attachment.path)
      }
      setPictures(key, remaining)
    },

    /** Keeps pasted pictures in files, then adds them to the screen they were pasted on, which may no longer be open. */
    paste: (pasted: PastedPicture[]) => {
      const key = openKey()
      const landing = Promise.all(
        pasted.map(async ({ name, file }) => ({
          path: await sidecar('drafts.picture', { name, data: toBase64(new Uint8Array(await file.arrayBuffer())) }),
          file,
        })),
      )
        .then((kept) => {
          for (const { path, file } of kept) previews.set(path, URL.createObjectURL(file))
          setPictures(key, [...draftOf(key).attachments, ...kept.map(({ path }) => path)])
        })
        .catch((err: unknown) => setError(String(err)))
      pastes.add(landing)
      void landing.finally(() => pastes.delete(landing))
    },

    /** Takes the saved drafts. They fill only the screens this window has not changed, since what it changed is newer. */
    take: (saved: AppState) => {
      for (const [key, { text, attachments, rev }] of Object.entries(saved.drafts)) {
        const local = screens[key]
        if (local === undefined) {
          const draft: Draft = { text, attachments }
          screens[key] = { draft, saved: { draft, rev } }
          if (key === openKey()) setShown(draft)
        } else if (key === START && !startPicturesTouched && local.draft.attachments.length === 0 && attachments.length > 0) {
          // The person only typed on the start screen before the saved state came, so its pictures come back. That
          // changes the draft. A project's screen never takes them back.
          put(START, { ...local.draft, attachments })
          autosave(START)
        }
      }
    },

    dismissSendError: (project: string) => state.setState(({ sendErrors: { [project]: _, ...rest } }) => ({ sendErrors: rest })),

    /**
     * A quit or the window's close waits for pasted pictures still being kept and each send on its way, then saves every
     * screen, those a send just made included. Rust holds the quit meanwhile. It is done only when no screen sends and
     * each holds what the store holds, so a send or an edit that came while it saved means another round. A save the
     * engine refused, as while it restarts, is tried again once the engine is back or a pause passes. A draft that still
     * cannot be saved after a few tries calls the quit off.
     */
    quit: async () => {
      clearPause()
      await Promise.allSettled([...pastes])
      for (let failures = 0; ; ) {
        await Promise.allSettled(Object.values(screens).map((screen) => screen.sending))
        const saves = await Promise.allSettled(Object.keys(screens).map((key) => flush(key)))
        const failed = saves.some((save) => save.status === 'rejected')
        const settled = Object.values(screens).every((screen) => screen.sending === undefined && !changed(screen))
        if (!failed && settled) return
        if (!failed) continue
        if (++failures === QUIT_SAVE_TRIES) {
          setError('A draft could not be saved, so Materialize 3D stayed open. Quit again once the engine is back.')
          throw new Error('a draft could not be saved')
        }
        await new Promise<void>((wake) => {
          onNextReady(wake)
          clock.after(QUIT_RETRY_MS, wake)
        })
      }
    },

    /** Frees the pictures' previews and drops a save still waiting for typing to pause, as the window closes. */
    close: () => {
      previews.forEach((url) => URL.revokeObjectURL(url))
      pending?.cancel()
    },
  }
}

/**
 * The window's drafts while it is open, with what the open screen's composer shows. It starts the window's store, and
 * `onStarted` hears the saved state once the drafts took it. Both callbacks are taken once.
 */
export function useDrafts({ onSent, onStarted }: { onSent: (project: Project) => void; onStarted: (saved: AppState) => void }) {
  const [drafts] = useState(() => createDrafts(windowClock, onSent))
  useEffect(() => {
    void start()
      .then((saved) => {
        drafts.take(saved)
        onStarted(saved)
      })
      .catch((err: unknown) => setError(String(err)))
  }, [drafts])
  useEffect(() => drafts.close, [drafts])
  useEffect(() => onQuitFlush(drafts.quit).stop, [drafts])
  // Files dropped anywhere on the window join the next message, as Attach adds them.
  useEffect(() => onFileDrop(drafts.attach).stop, [drafts])
  return { drafts, ...useStore(drafts.state) }
}
