import { useEffect, useMemo, useRef, useState } from 'react'
import { CATALOG } from '../../sidecar/src/offered'
import { type ModelChoice, type Setup, START } from '../../sidecar/src/protocol'
import { fileUrl, sidecar } from './api'
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
  takeProject,
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

/** A role picked here, with its place in the order of picks, shown until its own save went through. */
type ShownPick = { model: ModelChoice | null; seq: number }
type ShownPicks = { lead?: ShownPick & { model: ModelChoice }; helper?: ShownPick }

export default function StudioApp() {
  const { projects, current, view, files, selected, panelView, status, error, engine, setup, settings: savedSettings, importBlocked, needs, models, signIn, slicerFound, wentOnInSetup } = useStudio()
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

  useStudioEvents()
  useUpdateEvents()
  useWindowTheme()
  useEffect(() => {
    void checkForUpdatesAtLaunch()
  }, [])

  /**
   * The saves of the role picks, one after another in the order they were made, so two picks of one role land in that
   * order, and how many failed.
   */
  const saves = useRef<Promise<unknown>>(Promise.resolve())
  const failedSaves = useRef(0)
  /**
   * A quit: the role saves, then the drafts, again until a round in which no role save joined, so neither a pick nor
   * text made while it waited is left behind. A role save that failed since the quit began calls it off.
   */
  const quit = async (saveDrafts: () => Promise<void>) => {
    const failed = failedSaves.current
    for (let waited: unknown; waited !== saves.current; ) {
      waited = saves.current
      await waited
      if (failedSaves.current !== failed) throw new Error('a role pick could not be saved')
      await saveDrafts()
    }
  }

  const { drafts, shown, attachments, sending, sendErrors } = useDrafts(quit)

  const retryImport = () => {
    void importAgain().catch((err: unknown) => setError(String(err)))
  }

  const shownError = error ?? (current ? sendErrors[current.id] : undefined)
  const dismissError = () => {
    setError(null)
    if (current) drafts.dismissSendError(current.id)
  }

  /**
   * Picks shown before their saves went through, by project id, or `START` for the start screen's lead. A pick shows at
   * once, while project events only update the saved roles under it, so an older save never decides what shows. Once
   * the save of the newest pick of a role went through, or failed, the saved role shows again.
   */
  const [picks, setPicks] = useState<Record<string, ShownPicks>>({})
  const picked = picks[current?.id ?? START]

  /** The open project's own model, or the default for one from before the picker. On the start screen, the default. */
  const chosenModel = picked?.lead?.model ?? (current ? projects.find((p) => p.id === current.id)?.model : undefined) ?? savedSettings?.model ?? null

  /**
   * The helper the next start screen send gives its project, once the person picked one there. Until then, and again
   * after that send, it is the default: the newest Astra offered while the Astra setting is on, or none.
   */
  const [startHelper, setStartHelper] = useState<{ pick: ModelChoice | null } | null>(null)
  const helperFamily = CATALOG.families[CATALOG.helper]
  const astra = models.find((m) => m.provider === helperFamily?.provider && helperFamily.versions.some((v) => v.modelId === m.modelId))
  // With the Astra setting on, the default is Astra while the person is signed in to it, which only the model list says.
  const defaultHelper = savedSettings?.astra !== true ? null : models.length === 0 ? 'default' : astra === undefined ? null : { provider: astra.provider, modelId: astra.modelId }
  const chosenHelper =
    picked?.helper !== undefined ? picked.helper.model : current ? (projects.find((p) => p.id === current.id)?.helper ?? null) : startHelper === null ? defaultHelper : startHelper.pick

  const waiting = view?.waiting ?? null
  const turnLogin: TurnLogin | undefined = waiting?.kind === 'login' ? { kind: 'turn-login', provider: waiting.provider, name: waiting.name } : undefined
  const nextWaitsForLogin = turnLogin !== undefined && turnLogin.provider === chosenModel?.provider
  const blocker: Blocker | undefined = needs?.[0] ?? (nextWaitsForLogin ? turnLogin : undefined)
  const cause: SetupCause | undefined = blocker ?? turnLogin ?? (slicerFound === false && !wentOnInSetup ? { kind: 'slicer' } : undefined)
  // Send waits for the saved state, which says whether setup is done, and for the check.
  const notReady = setup?.done !== true || needs === null || blocker !== undefined

  /**
   * Shows a pick at once and saves it in the background, after the saves of earlier picks and after any send pressed
   * before it was answered. A send never waits for them: it carries the picks whose save it has not heard back from
   * (#373).
   */
  const pickCount = useRef(0)
  const pickRole = (key: string, role: keyof ShownPicks, model: ModelChoice | null, save: () => Promise<unknown>) => {
    pickCount.current += 1
    const seq = pickCount.current
    // Only this pick goes, and only while no newer pick of the role took its place.
    const drop = () => setPicks((all) => (all[key]?.[role]?.seq === seq ? { ...all, [key]: { ...all[key], [role]: undefined } } : all))
    setPicks((all) => ({ ...all, [key]: { ...all[key], [role]: { model, seq } } }))
    saves.current = saves.current.then(save).then(drop, (err: unknown) => {
      failedSaves.current += 1
      setError(String(err))
      drop()
    })
  }

  /**
   * A pick of the open project's lead, or on the start screen the default the next project takes. The check runs
   * again then, as the new model's provider may differ.
   */
  const pickModel = (model: ModelChoice) => {
    const project = current?.id
    if (project === undefined) {
      pickRole(START, 'lead', model, () => saveSettings({ model }).then(() => checkReady()))
      return
    }
    pickRole(project, 'lead', model, () => sidecar('projects.setLead', { project, model }).then(takeProject))
  }

  /** A pick of the open project's helper. On the start screen it is the helper the next project starts with. */
  const pickHelper = (model: ModelChoice | null) => {
    const project = current?.id
    if (project === undefined) {
      setStartHelper({ pick: model })
      return
    }
    pickRole(project, 'helper', model, () => sidecar('projects.setHelper', { project, model }).then(takeProject))
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
        if (running || notReady || chosenModel === null) return
        // A send carries only the roles picked here and not yet saved. The sidecar takes every other role from what is
        // saved when it accepts the turn, which the window may not have heard yet, as after a restart. A helper picked
        // on the start screen is saved only by the send, so it always goes with it.
        const helper = current ? picked?.helper : startHelper === null ? undefined : { model: startHelper.pick }
        const pending = { ...(picked?.lead === undefined ? {} : { lead: picked.lead.model }), ...(helper === undefined ? {} : { helper: helper.model }) }
        const sent = drafts.send(pending)
        // A pick made from now on saves once the sidecar answered this send, which it does after it accepted the turn,
        // so the pick goes to the next message and never to this one. The calls themselves can reach it in any order.
        saves.current = saves.current.then(() => sent)
        if (!current)
          void sent.then((project) => {
            // A helper picked while this send was on its way is the next chat's, so only the choice it carried resets.
            if (project !== undefined) setStartHelper((now) => (now === startHelper ? null : now))
          })
      }}
      onError={setError}
      onStop={current ? () => void sidecar('chat.stop', { project: current.id }).catch((err: unknown) => setError(String(err))) : undefined}
      busy={sending || running || notReady}
      running={running}
      locked={blocker === undefined ? undefined : lockedText(blocker)}
      picker={
        // A blocked chat with no model list has no lead to offer, but No helper needs no list, and clears a retired helper.
        <span className="model-roles">
          {(blocker === undefined || models.length > 0) && <ModelPicker role="Lead" models={models} chosen={chosenModel} onPick={pickModel} />}
          <ModelPicker role="Helper" models={models} chosen={chosenHelper} onPick={pickHelper} />
        </span>
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
              pictureUrl={(rel) => fileUrl(current.id, rel)}
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
