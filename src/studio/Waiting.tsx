import { useState } from 'react'
import type { LoginEvent, Need, Waiting } from '../../sidecar/src/protocol'
import { openFilesPrivacy, sidecar } from './api'
import { AGENTS } from './SetupCheck'

/** A turn that stopped until the person signs in to its provider again: the saved sign-in was refused, or is gone. */
export type TurnLogin = { kind: 'turn-login'; provider: string; name: string }

/** What keeps the next message from going out: a finding of the send check, or the sign-in a waiting turn needs. */
export type Blocker = Need | TurnLogin

/** Why setup is needed again. A missing slicer leaves Send on. */
export type SetupCause = Blocker | { kind: 'slicer' }

/** The agent's name as setup's rows show it, so the banner and the row it leads to say the same name. */
const agentName = ({ provider, name }: { provider: string; name: string }) => AGENTS.find((agent) => agent.provider === provider)?.name ?? name

/** What the composer says while `blocker` keeps Send off. */
export function lockedText(blocker: Blocker): string {
  switch (blocker.kind) {
    case 'login':
    case 'turn-login':
      return 'Log in to an agent to send'
    case 'uv':
      return 'Install uv to send'
    case 'python':
      return 'Install Python to send'
    case 'model':
      return 'Choose a model to send'
  }
}

function bannerText(cause: SetupCause): string {
  switch (cause.kind) {
    case 'login':
      return `${agentName(cause)} is logged out. Your chats are saved. Log in to keep working.`
    case 'turn-login':
      return `${agentName(cause)} needs a new login. Your chats are saved, and the message picks up where it stopped.`
    case 'uv':
      return 'uv is missing. Your chats are saved. Install it to keep working.'
    case 'python':
      return 'Python is missing. Your chats are saved. Install it to keep working.'
    case 'model':
      return cause.fix
    case 'slicer':
      return 'No slicer found. You can still design parts, but you won’t get print-ready 3MF files.'
  }
}

/**
 * Setup is needed again: what is missing, and Fix in setup, which opens setup's check. A model the app does not offer is
 * fixed in the model picker instead, so it has no button.
 */
export function SetupBanner({ cause, onFix }: { cause: SetupCause; onFix: () => void }) {
  return (
    <div className="setup-needed" role="status" data-testid="setup-needed">
      <span>{bannerText(cause)}</span>
      {cause.kind !== 'model' && (
        <button type="button" onClick={onFix}>
          Fix in setup
        </button>
      )}
    </div>
  )
}

/** A turn that stopped on an error, and the retry that lets it go on. */
export function WaitingBanner({ project, waiting, onError }: { project: string; waiting: Extract<Waiting, { kind: 'error' }>; onError: (message: string) => void }) {
  return (
    <div className="waiting" role="status" data-testid="waiting">
      <span>{waiting.detail}</span>
      <button type="button" onClick={() => void sidecar('chat.retry', { project }).catch((err: unknown) => onError(String(err)))}>
        {waiting.fix}
      </button>
    </div>
  )
}

/**
 * The chats from before the store sit in a folder macOS keeps from the app until the person allows it. Says how, opens
 * the setting, and imports them once the person tries again.
 */
export function ImportBlockedBanner({ folder, onRetry, onError }: { folder: string; onRetry: () => void; onError: (message: string) => void }) {
  return (
    <div className="waiting" role="status" data-testid="import-blocked">
      <span>
        Your earlier chats are in {folder}, and macOS has not let Materialize 3D read that folder. In Privacy & Security, open
        Files & Folders and turn on Documents Folder for Materialize 3D, then try again.
      </span>
      <button type="button" onClick={() => void openFilesPrivacy().catch((err: unknown) => onError(String(err)))}>
        Open Privacy settings
      </button>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

/** What a sign-in needs from the person: the code to enter on the page it opened, or an answer to its question. */
export function SignInAsk({ ask, onAnswer }: { ask: Extract<LoginEvent, { step: 'open' | 'ask' }>; onAnswer: (text: string) => void }) {
  const [text, setText] = useState('')
  if (ask.step === 'open') {
    return (
      <div className="waiting" role="status" data-testid="sign-in">
        <span>
          Enter the code {ask.code} at {ask.url}
        </span>
      </div>
    )
  }
  return (
    <div className="waiting" role="status" data-testid="sign-in">
      {ask.kind === 'select' ? (
        <>
          <span>{ask.message}</span>
          {ask.options?.map((option) => (
            <button type="button" key={option.id} onClick={() => onAnswer(option.id)}>
              {option.label}
            </button>
          ))}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onAnswer(text)
          }}
        >
          <input
            type={ask.kind === 'secret' ? 'password' : 'text'}
            placeholder={ask.message}
            aria-label={ask.message}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={text === ''}>
            Answer
          </button>
        </form>
      )}
    </div>
  )
}
