import { useState } from 'react'
import type { ProviderId } from '../../sidecar/src/protocol'
import { AGENTS } from './agents'
import { sidecar } from './api'
import { agentRows, buildRows, forgetRefused, type Found, type Row, signedIn, slicerRow } from './checkRows'
import type { StepProps } from './Setup'
import { CheckGroup, useFound } from './setupRows'

const INSTALL_HINT = 'Paste the install command in Terminal, then press Check again.'

type Verdict = { title: string; text?: string; hint?: string; go: 'wait' | 'blocked' | 'ready' | 'without-slicer' }

function verdictOf({ logins, toolchain, slicer }: Found): Verdict {
  if (logins === 'failed' || toolchain === 'failed' || slicer === 'failed') return { title: 'The check did not finish', text: 'Press Check again.', go: 'blocked' }
  if (logins === undefined || toolchain === undefined || slicer === undefined) return { title: 'Checking your Mac', go: 'wait' }
  if (!AGENTS.some(({ provider }) => signedIn(logins, provider))) {
    return { title: 'Sign in to an agent', text: 'The app needs one sign-in, Claude or ChatGPT.', go: 'blocked' }
  }
  if (toolchain.uv === null) return { title: 'One thing to install', text: 'The app needs uv to build and check your parts.', hint: INSTALL_HINT, go: 'blocked' }
  if (toolchain.python === null) return { title: 'One thing to install', text: 'uv needs a Python to run the build scripts.', hint: INSTALL_HINT, go: 'blocked' }
  if (slicer.found !== 'ready') {
    return {
      title: slicer.found === 'none' ? 'No slicer found' : 'Bambu Studio cannot slice',
      text: `You can still design parts and get assembly guides. You won’t get print-ready 3MF files until Bambu Studio ${slicer.found === 'none' ? 'is installed' : 'can slice'}.`,
      go: 'without-slicer',
    }
  }
  return { title: 'Your Mac is ready', text: 'Everything the app needs is here.', go: 'ready' }
}

export default function SetupCheck({ next, onError, signIn, refused }: StepProps) {
  const [round, setRound] = useState(0)
  const [keyFormFor, setKeyFormFor] = useState<ProviderId | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const found = useFound(onError, round)

  const withoutRefused = forgetRefused(found, refused)
  const verdict = verdictOf(withoutRefused)
  const copy = (command: string) =>
    void navigator.clipboard.writeText(command).then(
      () => setCopied(command),
      () => onError(`The command could not be copied. Run this in Terminal: ${command}`),
    )

  const act = ({ action }: Row) => {
    switch (action?.kind) {
      case undefined:
        return null
      case 'copy':
        return (
          <button type="button" onClick={() => copy(action.command)}>
            {copied === action.command ? 'Copied' : 'Copy install command'}
          </button>
        )
      case 'signIn':
        return (
          <>
            {action.key && (
              <button type="button" className="setup-link" aria-expanded={keyFormFor === action.provider} onClick={() => setKeyFormFor(keyFormFor === action.provider ? null : action.provider)}>
                Use a key
              </button>
            )}
            <button type="button" onClick={() => void sidecar('auth.login', { provider: action.provider }).catch((err: unknown) => onError(String(err)))}>
              Sign in
            </button>
          </>
        )
    }
  }

  return (
    <>
      <h1>{verdict.title}</h1>
      {verdict.text !== undefined && <p>{verdict.text}</p>}
      <CheckGroup title="Agent that does the work (at least one)" rows={agentRows(withoutRefused.logins, refused)} testId="check" act={act}>
        {keyFormFor !== null && Array.isArray(withoutRefused.logins) && !signedIn(withoutRefused.logins, keyFormFor) && (
          <div className="setup-key">
            <KeyForm provider={keyFormFor} onError={onError} />
          </div>
        )}
        {signIn}
      </CheckGroup>
      <CheckGroup title="Slicer (makes the 3MF)" rows={[slicerRow(found.slicer)]} testId="check" act={act} />
      <CheckGroup title="Build tools (required)" rows={buildRows(found.toolchain)} testId="check" act={act} />
      {verdict.hint !== undefined && <p className="setup-hint">{verdict.hint}</p>}
      <div className="setup-actions">
        {verdict.go !== 'wait' && (
          <button
            type="button"
            onClick={() => {
              setCopied(null)
              setRound(round + 1)
            }}
          >
            Check again
          </button>
        )}
        <button type="button" className="primary" disabled={verdict.go === 'wait' || verdict.go === 'blocked'} onClick={() => void next()}>
          {verdict.go === 'without-slicer' ? 'Continue without a slicer' : 'Continue'}
        </button>
      </div>
    </>
  )
}

function KeyForm({ provider, onError }: { provider: ProviderId; onError: (message: string) => void }) {
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
