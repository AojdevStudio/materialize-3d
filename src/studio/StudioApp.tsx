import { useEffect, useMemo, useRef, useState } from 'react'
import { type AppState, type Draft, type ModelChoice, type Project, type Setup, START } from '../../sidecar/src/protocol'
import { onFileDrop, onQuitFlush, sidecar } from './api'
import { ChatView } from './Chat'
import { Composer, releaseAttachment, savedAttachment, type PastedPicture } from './Composer'
import ModelPicker from './ModelPicker'
import RightPanel from './RightPanel'
import SetupFlow, { SetupStep } from './Setup'
import Settings, { type Section } from './Settings'
import Start from './Start'
import {
  afterSetup,
  answerSignIn,
  checkReady,
  importAgain,
  load,
  onNextReady,
  openFile,
  retry,
  saveSettings,
  setError,
  setPanelView,
  show as showProject,
  start,
  useStudio,
  useStudioEvents,
} from './store'
import { buildChat } from './transcript'
import Sidebar from './Sidebar'
import { useWindowTheme } from './theme'
import { ImportBlockedBanner, lockedText, SetupBanner, SignInAsk, WaitingBanner, type Blocker, type SetupCause, type TurnLogin } from './Waiting'
import { UpdateBanner } from '../update/UpdateBanner'
import { checkForUpdatesAtLaunch, useUpdateEvents } from '../update/store'
import './studio.css'

const DRAFT_PAUSE_MS = 400

const EMPTY: Draft = { text: '', attachments: [] }

const QUIT_SAVE_TRIES = 4
const QUIT_RETRY_MS = 3000

/**
 * A screen's unsent message as the window holds it. The sidecar owns the draft and the send: the window only knows
 * whether the screen changed since its last completed save, and that save's revision, which a send names.
 */
type Screen = {
  draft: Draft
  /** The last save that completed: the draft it saved, and its revision. None while the store holds no draft. */
  saved?: { draft: Draft; rev: number }
  /** The save on its way. A screen has one at a time. */
  saving?: Promise<void>
  /** The send on its way. Nothing else saves the screen meanwhile, as that would replace the draft it sends. */
  sending?: Promise<void>
  /**
   * The pictures that send carries, but for any the person took out since. A sent picture leaves the next draft when
   * the send goes through, unless the person took it out and chose it again.
   */
  sendingPictures?: Set<string>
}

/** Whether the screen changed since its last completed save. Each change makes a new draft object. */
const changed = (screen: Screen) => screen.draft !== (screen.saved?.draft ?? EMPTY)

/** A pasted picture's bytes as base64, to cross the sidecar's pipe. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export default function StudioApp() {
  const [projects, setProjects] = useState<Project[]>([])
  const { current, view, files, selected, panelView, status, error, engine, setup, settings: savedSettings, importBlocked, needs, models, signIn, slicerFound, wentOnInSetup } = useStudio()
  /** A failed send's error, kept with the project it was sent to and shown only there. */
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({})
  /** The open screen's draft, as its composer shows it. */
  const [shown, setShown] = useState<Draft>(EMPTY)
  const [sending, setSending] = useState(false)
  /** The setup step opened again, and which opening it is, so a step left earlier cannot close a later one. */
  const [fixing, setFixing] = useState<{ step: Setup['step']; opening: number } | null>(null)
  const openings = useRef(0)
  const openFix = (step: Setup['step']) => {
    openings.current += 1
    setFixing({ step, opening: openings.current })
  }
  /** The Settings section on screen. Closing it shows the screen it was opened from. */
  const [settings, setSettings] = useState<Section | null>(null)
  const sendingNow = useRef(false)
  /**
   * Each screen the window changed or filled from the saved state, by project id, or `START` for the start screen.
   * Typing saves its screen once typing pauses, and at once when the person leaves it. A send saves first if the
   * screen changed, then names the revision. A draft keeps its pictures as the paths of their files.
   */
  const screens = useRef<Record<string, Screen>>({})
  /** The open screen's save that waits for typing to pause. */
  const pending = useRef<{ key: string; timer: number } | null>(null)
  /** Pastes whose pictures are still being kept, so a quit waits for them. */
  const pastes = useRef(new Set<Promise<void>>())
  /** The previews of pasted pictures, by path, freed when the window closes. */
  const previews = useRef(new Map<string, string>())
  /** Whether the person changed the start screen's pictures, so its saved ones no longer fill it. */
  const startPicturesTouched = useRef(false)

  const items = useMemo(() => buildChat(view?.entries ?? [], view?.running ?? true), [view?.entries, view?.running])
  const running = view?.running ?? false
  const attachments = shown.attachments.map((path) => ({ ...savedAttachment(path), previewUrl: previews.current.get(path) }))

  useStudioEvents(projects)
  useUpdateEvents()
  useWindowTheme()
  useEffect(() => {
    void checkForUpdatesAtLaunch()
  }, [])

  const openKey = () => useStudio.getState().current?.id ?? START
  const draftOf = (key: string) => screens.current[key]?.draft ?? EMPTY

  const put = (key: string, draft: Draft) => {
    ;(screens.current[key] ??= { draft }).draft = draft
    if (key === openKey()) setShown(draft)
  }

  /** Empties a screen whose draft the store no longer holds. */
  const clear = (key: string) => {
    put(key, EMPTY)
    delete screens.current[key].saved
  }

  /**
   * Saves a screen until the store holds what it shows, one save at a time: a save wanted while one runs waits for it,
   * then saves the newest draft. While the screen's send is on its way, only that send saves it, and it saves `going`,
   * the draft taken at the click, so text typed while an earlier save finished stays the next message. Answers the last
   * completed save.
   */
  const flush = async (key: string, going?: Draft) => {
    const screen = screens.current[key]
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
    if (pending.current !== null) window.clearTimeout(pending.current.timer)
    pending.current = null
  }

  const edit = (draft: Draft) => {
    const key = openKey()
    put(key, draft)
    clearPause()
    const timer = window.setTimeout(() => {
      pending.current = null
      autosave(key)
    }, DRAFT_PAUSE_MS)
    pending.current = { key, timer }
  }

  const takeState = (state: AppState) => {
    // The saved state fills only the screens this window has not changed, since what it changed is newer.
    for (const [key, saved] of Object.entries(state.drafts)) {
      const local = screens.current[key]
      if (local === undefined) {
        const draft: Draft = { text: saved.text, attachments: saved.attachments }
        screens.current[key] = { draft, saved: { draft, rev: saved.rev } }
        if (key === openKey()) setShown(draft)
      } else if (key === START && !startPicturesTouched.current && local.draft.attachments.length === 0 && saved.attachments.length > 0) {
        // The person only typed here before the saved state came, so its pictures come back. That changes the draft.
        put(START, { ...local.draft, attachments: saved.attachments })
        autosave(START)
      }
    }
    takeProjects(state)
  }

  // A project made while this was on its way is newer than the saved list, so it stays.
  const takeProjects = (state: AppState) =>
    setProjects((made) => [...made.filter((p) => !state.projects.some((saved) => saved.id === p.id)), ...state.projects])

  const retryImport = () => {
    void importAgain()
      .then(takeProjects)
      .catch((err: unknown) => setError(String(err)))
  }

  useEffect(() => {
    void start()
      .then(takeState)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), [])
  useEffect(() => () => window.clearTimeout(pending.current?.timer), [])

  const type = (text: string) => edit({ ...draftOf(openKey()), text })

  const setAttachments = (paths: string[]) => {
    if (openKey() === START) startPicturesTouched.current = true
    const sending = screens.current[openKey()]?.sendingPictures
    for (const path of draftOf(openKey()).attachments) if (!paths.includes(path)) sending?.delete(path)
    edit({ ...draftOf(openKey()), attachments: paths })
  }

  /**
   * Keeps pasted pictures in files, then adds them to the screen they were pasted on: to its composer if the person is
   * there, or else to its draft, saved as any change is.
   */
  const pastePictures = (pasted: PastedPicture[]) => {
    const key = openKey()
    const landing = Promise.all(
      pasted.map(async ({ name, file }) => ({
        path: await sidecar('drafts.picture', { name, data: toBase64(new Uint8Array(await file.arrayBuffer())) }),
        file,
      })),
    )
      .then((kept) => {
        for (const { path, file } of kept) previews.current.set(path, URL.createObjectURL(file))
        const paths = [...draftOf(key).attachments, ...kept.map(({ path }) => path)]
        if (openKey() === key) {
          setAttachments(paths)
          return
        }
        if (key === START) startPicturesTouched.current = true
        put(key, { ...draftOf(key), attachments: paths })
        autosave(key)
      })
      .catch((err: unknown) => setError(String(err)))
    pastes.current.add(landing)
    void landing.finally(() => pastes.current.delete(landing))
  }

  // A quit or the window's close waits for pasted pictures still being kept and each send on its way, then saves every
  // screen, those a send just made included. Rust holds the quit meanwhile. A save the engine refused, as while it
  // restarts, is tried again once the engine is back. A draft that still cannot be saved calls the quit off.
  useEffect(() => {
    const quitting = onQuitFlush(async () => {
      clearPause()
      await Promise.allSettled([...pastes.current])
      // It is done only when no screen sends and each holds what the store holds. A send or an edit that came while it
      // saved, so a screen skipped or changed meanwhile, means another round. A save that failed is tried again once
      // the engine is back, a few times, before the quit is called off.
      for (let failures = 0; ; ) {
        await Promise.allSettled(Object.values(screens.current).map((screen) => screen.sending))
        const saves = await Promise.allSettled(Object.keys(screens.current).map((key) => flush(key)))
        const failed = saves.some((save) => save.status === 'rejected')
        const settled = Object.values(screens.current).every((screen) => screen.sending === undefined && !changed(screen))
        if (!failed && settled) return
        if (!failed) continue
        if (++failures === QUIT_SAVE_TRIES) {
          setError('A draft could not be saved, so Materialize 3D stayed open. Quit again once the engine is back.')
          throw new Error('a draft could not be saved')
        }
        await new Promise<void>((wake) => {
          onNextReady(wake)
          window.setTimeout(wake, QUIT_RETRY_MS)
        })
      }
    })
    return quitting.stop
  }, [])

  // Files dropped anywhere on the window join the next message, as Attach adds them.
  useEffect(() => onFileDrop((paths) => setAttachments([...draftOf(openKey()).attachments, ...paths])).stop, [])

  /** Shows a project, or the start screen, with its draft. The screen left is saved at once. */
  const show = (project: Project | null) => {
    clearPause()
    autosave(openKey())
    showProject(project)
    setShown(draftOf(openKey()))
    checkReady()
  }

  const openProject = (project: Project) => {
    if (project.id !== useStudio.getState().current?.id) show(project)
    else if (!retry()) return
    void load()
  }

  /**
   * Sends the open screen's draft by its revision: saved first if it changed, and a save that fails ends the send. The
   * sidecar makes the project for a first message, copies the pictures, and removes the draft it sent.
   */
  const send = async () => {
    const key = openKey()
    const screen = screens.current[key]
    if (screen === undefined || (screen.draft.text.trim() === '' && screen.draft.attachments.length === 0) || sendingNow.current || running || notReady) return
    sendingNow.current = true
    setSending(true)
    clearPause()
    let done = () => {}
    screen.sending = new Promise((resolve) => (done = resolve))
    try {
      screen.sendingPictures = new Set(screen.draft.attachments)
      const sent = await flush(key, screen.draft)
      if (sent === undefined) return
      const { project } = await sidecar('chat.send', { key, rev: sent.rev })
      setSendErrors(({ [project.id]: _, ...rest }) => rest)
      setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [project, ...prev]))
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
        openProject(project)
        autosave(project.id)
      } else if (unchanged) {
        clear(key)
      } else if (key !== START && next.attachments.length !== screen.draft.attachments.length) {
        put(key, next)
      }
    } catch (err) {
      const message = String(err)
      if (key !== START) setSendErrors((prev) => ({ ...prev, [key]: message }))
      else if (openKey() === START) setError(message)
    } finally {
      delete screen.sending
      delete screen.sendingPictures
      done()
      sendingNow.current = false
      setSending(false)
      autosave(key)
    }
  }

  const shownError = error ?? (current ? sendErrors[current.id] : undefined)
  const dismissError = () => {
    setError(null)
    if (current) setSendErrors(({ [current.id]: _, ...rest }) => rest)
  }

  /** The open project's own model, or the default for one from before the picker. On the start screen, the default. */
  const chosenModel = (current ? projects.find((p) => p.id === current.id)?.model : undefined) ?? savedSettings?.model ?? null

  const waiting = view?.waiting ?? null
  const turnLogin: TurnLogin | undefined = waiting?.kind === 'login' ? { kind: 'turn-login', provider: waiting.provider, name: waiting.name } : undefined
  const nextWaitsForLogin = turnLogin !== undefined && turnLogin.provider === chosenModel?.provider
  const blocker: Blocker | undefined = needs?.[0] ?? (nextWaitsForLogin ? turnLogin : undefined)
  const cause: SetupCause | undefined = blocker ?? turnLogin ?? (slicerFound === false && !wentOnInSetup ? { kind: 'slicer' } : undefined)
  // Send waits for the saved state, which says whether setup is done, and for the check.
  const notReady = setup?.done !== true || needs === null || blocker !== undefined

  /**
   * Saves a pick: the open project's model, or on the start screen the default the next project takes. The check runs
   * again then, as the new model's provider may differ.
   */
  const pickModel = (model: ModelChoice) => {
    const project = current?.id
    if (project === undefined) {
      void saveSettings({ model })
        .then(() => checkReady())
        .catch((err: unknown) => setError(String(err)))
      return
    }
    void sidecar('projects.setModel', { project, model })
      .then(() => {
        setProjects((all) => all.map((p) => (p.id === project ? { ...p, model } : p)))
        checkReady()
      })
      .catch((err: unknown) => setError(String(err)))
  }

  const composer = (placeholder: string, autoFocus: boolean) => (
    <Composer
      text={shown.text}
      onText={type}
      attachments={attachments}
      onAttach={(more) => setAttachments([...draftOf(openKey()).attachments, ...more.map((a) => a.path)])}
      onPaste={pastePictures}
      onRemove={(index) => {
        releaseAttachment(attachments[index])
        previews.current.delete(shown.attachments[index])
        setAttachments(draftOf(openKey()).attachments.filter((_, i) => i !== index))
      }}
      onSend={() => void send()}
      onError={setError}
      onStop={current ? () => void sidecar('chat.stop', { project: current.id }).catch((err: unknown) => setError(String(err))) : undefined}
      busy={sending || running || notReady}
      running={running}
      placeholder={placeholder}
      locked={blocker === undefined ? undefined : lockedText(blocker)}
      autoFocus={autoFocus}
      hint={current ? undefined : 'Photo, PDF, 3MF, STL'}
      sendLabel={current ? 'Send' : 'Start'}
      picker={blocker !== undefined && models.length === 0 ? null : <ModelPicker models={models} chosen={chosenModel} onPick={pickModel} />}
    />
  )

  const errorBar = shownError && (
    <div className="error-bar" role="alert">
      <span>{shownError}</span>
      <button type="button" onClick={dismissError} aria-label="Dismiss">×</button>
    </div>
  )
  const signInAsk = signIn && (
    <SignInAsk
      key={signIn.step === 'ask' ? signIn.message : signIn.url}
      ask={signIn}
      onAnswer={(answer) => answerSignIn(signIn.provider, answer)}
    />
  )

  if (setup !== null && !setup.done) {
    return (
      <SetupFlow setup={setup} onError={setError} error={errorBar} signIn={signInAsk} />
    )
  }

  if (fixing !== null) {
    const { step, opening } = fixing
    return (
      <SetupStep
        key={opening}
        step={step}
        refused={turnLogin?.provider}
        onDone={(wentOn) => {
          // A save that ends after its step was left still counts, but closes only the opening it came from.
          if (openings.current === opening) setFixing(null)
          afterSetup(wentOn && step === 'check')
        }}
        onError={setError}
        error={errorBar}
        signIn={signInAsk}
      />
    )
  }

  if (settings !== null) {
    return (
      <Settings
        section={settings}
        onSection={setSettings}
        onFix={openFix}
        onClose={() => setSettings(null)}
        onError={setError}
        error={errorBar}
        signIn={signInAsk}
        refused={turnLogin?.provider}
      />
    )
  }

  return (
    <div className={`studio ${current ? 'studio-work' : 'studio-start'}`}>
      <Sidebar
        projects={projects}
        current={current?.id ?? null}
        engine={engine}
        printer={savedSettings?.printer ?? null}
        onOpen={openProject}
        onNew={() => show(null)}
        onSettings={() => setSettings('agents')}
      />

      <main className="chat" aria-label="Chat">
        <UpdateBanner />
        {errorBar}
        {importBlocked !== null && <ImportBlockedBanner folder={importBlocked} onRetry={retryImport} onError={setError} />}
        {signInAsk}
        {cause !== undefined && <SetupBanner cause={cause} onFix={() => openFix('check')} />}
        {current ? (
          <>
            {waiting?.kind === 'error' && <WaitingBanner project={current.id} waiting={waiting} onError={setError} />}
            <ChatView
              project={current.id}
              items={items}
              running={running}
              startedMs={view?.turn?.startedMs}
              onError={setError}
            />
            {composer('Reply, paste a link, or attach a file', false)}
          </>
        ) : (
          <Start
            projects={projects}
            status={status}
            composer={composer('Describe the part, paste a link, or attach a file', true)}
            onSuggest={type}
            onOpen={openProject}
            onError={setError}
          />
        )}
      </main>

      {current && (
        <RightPanel project={current.id} files={files} view={panelView ?? 'guide'} selected={selected} onView={setPanelView} onOpen={openFile} onError={setError} />
      )}
    </div>
  )
}
