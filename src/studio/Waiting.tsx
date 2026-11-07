import { useState } from 'react'
import type { LoginEvent, ProviderId, Waiting } from '../../sidecar/src/protocol'
import { sidecar } from './api'

/** Providers a key or a proxy can sign in to, and those with a subscription sign-in. */
const KEYS: readonly string[] = ['anthropic', 'opencode-go']
const OAUTH: Record<string, string> = { anthropic: 'Sign in with Claude', 'openai-codex': 'Sign in with ChatGPT' }

/**
 * Why the open chat's turn stopped, and the one thing that lets it go on: a sign-in, or a retry. Once the fix is in,
 * the turn picks up where it stopped on its own.
 */
export function WaitingBanner({ project, waiting, onError }: { project: string; waiting: Waiting; onError: (message: string) => void }) {
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
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
  const provider = waiting.provider as ProviderId
  return (
    <div className="waiting" role="status" data-testid="waiting">
      <span>{waiting.fix}</span>
      {OAUTH[provider] !== undefined && (
        <button type="button" onClick={() => run(sidecar('auth.login', { provider }))}>
          {OAUTH[provider]}
        </button>
      )}
      {KEYS.includes(provider) && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            run(sidecar('auth.setKey', { provider, key, ...(baseUrl === '' ? {} : { baseUrl }) }))
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
      )}
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
