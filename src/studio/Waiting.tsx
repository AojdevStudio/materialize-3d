import { useState } from 'react'
import type { LoginEvent, Need, ProviderId, Waiting } from '../../sidecar/src/protocol'
import { openFilesPrivacy, sidecar } from './api'

/** Providers a key or a proxy can sign in to, and those with a subscription sign-in. */
const KEYS: readonly string[] = ['anthropic', 'opencode-go']
const OAUTH: Record<string, string> = { anthropic: 'Sign in with Claude', 'openai-codex': 'Sign in with ChatGPT' }

/**
 * Why the open chat's turn stopped, and the one thing that lets it go on: a sign-in, or a retry. Once the fix is in,
 * the turn picks up where it stopped on its own.
 */
export function WaitingBanner({ project, waiting, onError }: { project: string; waiting: Waiting; onError: (message: string) => void }) {
  const run = (work: Promise<unknown>) => void work.catch((err: unknown) => onError(String(err)))

  if (waiting.kind === 'error') {
    return (
      <div className="waiting" role="status" data-testid="waiting">
        <span>{waiting.detail}</span>
        <button type="button" onClick={() => run(sidecar('chat.retry', { project }))}>
          {waiting.fix}
        </button>
      </div>
    )
  }
  return (
    <div className="waiting" role="status" data-testid="waiting">
      <span>{waiting.fix}</span>
      <SignInControls provider={waiting.provider as ProviderId} onError={onError} />
    </div>
  )
}

/** The ways to sign in to `provider`: its subscription sign-in, and a key or a proxy where it takes one. */
function SignInControls({ provider, onError }: { provider: ProviderId; onError: (message: string) => void }) {
  const run = (work: Promise<unknown>) => void work.catch((err: unknown) => onError(String(err)))
  return (
    <>
      {OAUTH[provider] !== undefined && (
        <button type="button" onClick={() => run(sidecar('auth.login', { provider }))}>
          {OAUTH[provider]}
        </button>
      )}
      {KEYS.includes(provider) && <KeyForm provider={provider} onError={onError} />}
    </>
  )
}

/** A sign-in with an API key or a proxy's token, and for Anthropic the proxy's URL. */
export function KeyForm({ provider, onError }: { provider: ProviderId; onError: (message: string) => void }) {
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void sidecar('auth.setKey', { provider, key, ...(baseUrl === '' ? {} : { baseUrl }) }).catch((err: unknown) => onError(String(err)))
      }}
    >
      <input type="password" placeholder="API key or token" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API key or token" />
      {provider === 'anthropic' && (
        <input placeholder="Proxy URL (optional)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Proxy URL" />
      )}
      <button type="submit" disabled={key === ''}>
        Save
      </button>
    </form>
  )
}

/**
 * What the agent needs before a message can go out, with the one thing that gives it: a sign-in, or uv or a Python
 * to install. Send stays off until the check finds nothing missing.
 */
export function ReadinessBanner({ needs, onCheck, onError }: { needs: Need[]; onCheck: () => void; onError: (message: string) => void }) {
  const [need] = needs
  if (need === undefined) return null
  return (
    <div className="waiting" role="status" data-testid="readiness">
      <span>{need.fix}</span>
      {need.kind === 'login' && <SignInControls provider={need.provider} onError={onError} />}
      <button type="button" onClick={onCheck}>
        Check again
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
