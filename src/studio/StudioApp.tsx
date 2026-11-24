import { useEffect, useMemo, useRef, useState } from 'react'
import { CATALOG } from '../../sidecar/src/offered'
import type { AppState, ModelChoice, Project, Setup } from '../../sidecar/src/protocol'
import { onSidecarEvent, sidecar } from './api'
import { ChatView } from './Chat'
import { Composer } from './Composer'
import { useDrafts } from './drafts'
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
  openFile,
  saveSettings,
  setError,
  setPanelView,
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

export default function StudioApp() {
  const [projects, setProjects] = useState<Project[]>([])
  const { current, view, files, selected, panelView, status, error, engine, setup, settings: savedSettings, importBlocked, needs, models, signIn, slicerFound, wentOnInSetup } = useStudio()
  /** The setup step opened again, and which opening it is, so a step left earlier cannot close a later one. */
  const [fixing, setFixing] = useState<{ step: Setup['step']; opening: number } | null>(null)
  const openings = useRef(0)
  const openFix = (step: Setup['step']) => {
    openings.current += 1
    setFixing({ step, opening: openings.current })
  }
  /** The Settings section on screen. Closing it shows the screen it was opened from. */
  const [settings, setSettings] = useState<Section | null>(null)

  const items = useMemo(
    () => buildChat(view?.entries ?? [], view?.running ?? true, view?.handoffs ?? []),
    [view?.entries, view?.running, view?.handoffs],
  )
  const running = view?.running ?? false

  useStudioEvents(projects)
  // A paired phone can change a chat's roles too, so the window takes each project the sidecar says changed, and checks
  // again what the next send needs, as after a pick here.
  useEffect(
    () =>
      onSidecarEvent((event) => {
        if (event.type !== 'project') return
        setProjects((all) => all.map((p) => (p.id === event.project.id ? event.project : p)))
        checkReady()
      }).stop,
    [],
  )
  useUpdateEvents()
  useWindowTheme()
  useEffect(() => {
    void checkForUpdatesAtLaunch()
  }, [])

  // A project made while this was on its way is newer than the saved list, so it stays.
  const takeProjects = (state: AppState) =>
    setProjects((made) => [...made.filter((p) => !state.projects.some((saved) => saved.id === p.id)), ...state.projects])

  const { drafts, shown, attachments, sending, sendErrors } = useDrafts({
    onSent: (project) => setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [project, ...prev])),
    onStarted: takeProjects,
  })

  const retryImport = () => {
    void importAgain()
      .then(takeProjects)
      .catch((err: unknown) => setError(String(err)))
  }

  const shownError = error ?? (current ? sendErrors[current.id] : undefined)
  const dismissError = () => {
    setError(null)
    if (current) drafts.dismissSendError(current.id)
  }

  /** The open project's own model, or the default for one from before the picker. On the start screen, the default. */
  const chosenModel = (current ? projects.find((p) => p.id === current.id)?.model : undefined) ?? savedSettings?.model ?? null

  /**
   * The helper the next start screen send gives its project, once the person picked one there. Until then, and again
   * after that send, it is the default: the newest Astra offered while the Astra setting is on, or none.
   */
  const [startHelper, setStartHelper] = useState<{ pick: ModelChoice | null } | null>(null)
  const helperFamily = CATALOG.families[CATALOG.helper]
  const astra = models.find((m) => m.provider === helperFamily?.provider && helperFamily.versions.some((v) => v.modelId === m.modelId))
  const defaultHelper = savedSettings?.astra === true && astra !== undefined ? { provider: astra.provider, modelId: astra.modelId } : null
  const chosenHelper = current ? (projects.find((p) => p.id === current.id)?.helper ?? null) : startHelper === null ? defaultHelper : startHelper.pick

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
    void sidecar('projects.setLead', { project, model })
      .then(() => {
        setProjects((all) => all.map((p) => (p.id === project ? { ...p, model } : p)))
        checkReady()
      })
      .catch((err: unknown) => setError(String(err)))
  }

  /**
   * Saves a helper pick: the open project's helper, which the check reads again, as a retired one holds the next
   * message. On the start screen it is the helper the next project starts with.
   */
  const pickHelper = (model: ModelChoice | null) => {
    const project = current?.id
    if (project === undefined) {
      setStartHelper({ pick: model })
      return
    }
    void sidecar('projects.setHelper', { project, model })
      .then(() => {
        setProjects((all) => all.map((p) => (p.id === project ? { ...p, helper: model } : p)))
        checkReady()
      })
      .catch((err: unknown) => setError(String(err)))
  }

  const composer = (
    <Composer
      place={current ? 'chat' : 'start'}
      text={shown.text}
      onText={drafts.type}
      attachments={attachments}
      onAttach={(more) => drafts.attach(more.map((a) => a.path))}
      onPaste={drafts.paste}
      onRemove={(index) => drafts.remove(attachments[index], index)}
      onSend={() => {
        if (running || notReady) return
        if (current) void drafts.send()
        // Only a helper the person picked goes with the send. Without a pick the sidecar gives the default, which the
        // window may not know yet, as before the model list arrives.
        else
          void drafts.send(startHelper?.pick).then((project) => {
            // A pick made while the send was out is the next chat's, so only the pick that went resets.
            if (project !== undefined) setStartHelper((now) => (now === startHelper ? null : now))
          })
      }}
      onError={setError}
      onStop={current ? () => void sidecar('chat.stop', { project: current.id }).catch((err: unknown) => setError(String(err))) : undefined}
      busy={sending || running || notReady}
      running={running}
      locked={blocker === undefined ? undefined : lockedText(blocker)}
      picker={
        blocker !== undefined && models.length === 0 ? null : (
          <span className="model-roles">
            <ModelPicker role="Lead" models={models} chosen={chosenModel} onPick={pickModel} />
            <ModelPicker role="Helper" models={models} chosen={chosenHelper} onPick={pickHelper} />
          </span>
        )
      }
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
        onOpen={drafts.open}
        onNew={() => drafts.show(null)}
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
            {composer}
          </>
        ) : (
          <Start
            projects={projects}
            status={status}
            composer={composer}
            onSuggest={drafts.type}
            onOpen={drafts.open}
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
