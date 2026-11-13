import { type ReactNode, useEffect, useState } from 'react'
import type { Login, ProviderId, Toolchain } from '../../sidecar/src/protocol'
import bambu from '../assets/icons/bambu-studio.svg?raw'
import claude from '../assets/icons/claude.svg?raw'
import openai from '../assets/icons/openai.svg?raw'
import python from '../assets/icons/python.svg?raw'
import uv from '../assets/icons/uv.svg?raw'
import { checkSlicer, sidecar, type SlicerCheck } from './api'
import type { StepProps } from './Setup'
import { KeyForm } from './Waiting'

type Found = { logins?: Login[]; toolchain?: Toolchain; slicer?: SlicerCheck }

type Status = 'checking' | 'ready' | 'needs' | 'required-missing' | 'optional-missing'
type Action = { kind: 'signIn'; provider: ProviderId; key: boolean } | { kind: 'copy'; command: string }
type Row = { id: string; name: string; icon: string; status: Status; label: string; detail: string; action?: Action }

const AGENTS: readonly { id: string; provider: ProviderId; name: string; icon: string }[] = [
  { id: 'claude', provider: 'anthropic', name: 'Claude', icon: claude },
  { id: 'chatgpt', provider: 'openai-codex', name: 'ChatGPT', icon: openai },
]

const INSTALL_UV = 'curl -LsSf https://astral.sh/uv/install.sh | sh'
const INSTALL_PYTHON = 'uv python install'
const INSTALL_HINT = 'Paste the install command in Terminal, then press Check again.'

const loginOf = (logins: Login[], provider: ProviderId) => logins.find((login) => login.provider === provider)
const signedIn = (logins: Login[], provider: ProviderId) => (loginOf(logins, provider)?.login ?? null) !== null

function agentRows(logins: Login[] | undefined): Row[] {
  return AGENTS.map(({ id, provider, name, icon }) => {
    if (logins === undefined) return { id, name, icon, status: 'checking', label: 'Checking', detail: 'Looking for your sign-in…' }
    const login = loginOf(logins, provider)
    if (login?.login === 'oauth') return { id, name, icon, status: 'ready', label: 'Ready', detail: `Signed in with your ${name} plan.` }
    if (login?.login === 'api_key') return { id, name, icon, status: 'ready', label: 'Ready', detail: 'Signed in with a key or a proxy.' }
    const other = AGENTS.find((agent) => agent.provider !== provider && signedIn(logins, agent.provider))
    return {
      id,
      name,
      icon,
      status: 'needs',
      label: 'Needs login',
      detail: other === undefined ? 'Not signed in.' : `Not signed in. Optional while ${other.name} works.`,
      action: { kind: 'signIn', provider, key: login?.kinds.includes('api_key') ?? false },
    }
  })
}

function slicerRow(slicer: SlicerCheck | undefined): Row {
  const row = { id: 'bambu', name: 'Bambu Studio', icon: bambu }
  if (slicer === undefined) return { ...row, status: 'checking', label: 'Checking', detail: 'Looking for Bambu Studio…' }
  switch (slicer.found) {
    case 'ready':
      return { ...row, status: 'ready', label: 'Ready', detail: `Version ${slicer.version}.` }
    case 'none':
      return { ...row, status: 'optional-missing', label: 'Not found', detail: 'Not installed. Bambu Studio makes the print-ready 3MF.' }
    case 'other':
      return { ...row, status: 'optional-missing', label: 'Not found', detail: slicer.detail }
  }
}

function buildRows(toolchain: Toolchain | undefined): Row[] {
  const uvRow = { id: 'uv', name: 'uv', icon: uv }
  const pythonRow = { id: 'python', name: 'Python', icon: python }
  if (toolchain === undefined) {
    return [
      { ...uvRow, status: 'checking', label: 'Checking', detail: 'Looking for uv…' },
      { ...pythonRow, status: 'checking', label: 'Checking', detail: 'Looking for Python…' },
    ]
  }
  if (toolchain.uv === null) {
    return [
      { ...uvRow, status: 'required-missing', label: 'Missing', detail: 'Not installed. It builds and checks the parts.', action: { kind: 'copy', command: INSTALL_UV } },
      { ...pythonRow, status: 'needs', label: 'Needs uv', detail: 'uv finds Python once it is installed.' },
    ]
  }
  return [
    { ...uvRow, status: 'ready', label: 'Ready', detail: `Version ${toolchain.uv}.` },
    toolchain.python === null
      ? { ...pythonRow, status: 'required-missing', label: 'Missing', detail: 'uv finds no Python to run the build scripts.', action: { kind: 'copy', command: INSTALL_PYTHON } }
      : { ...pythonRow, status: 'ready', label: 'Ready', detail: `Version ${toolchain.python}. uv uses it to run the build scripts.` },
  ]
}

type Verdict = { title: string; text?: string; hint?: string; go: 'wait' | 'blocked' | 'ready' | 'without-slicer' }

function verdictOf({ logins, toolchain, slicer }: Found): Verdict {
  if (logins === undefined || toolchain === undefined || slicer === undefined) return { title: 'Checking your Mac', go: 'wait' }
  if (!AGENTS.some(({ provider }) => signedIn(logins, provider))) {
    return { title: 'Sign in to an agent', text: 'The app needs one sign-in, Claude or ChatGPT.', go: 'blocked' }
  }
  if (toolchain.uv === null) return { title: 'One thing to install', text: 'The app needs uv to build and check your parts.', hint: INSTALL_HINT, go: 'blocked' }
  if (toolchain.python === null) return { title: 'One thing to install', text: 'uv needs a Python to run the build scripts.', hint: INSTALL_HINT, go: 'blocked' }
  if (slicer.found !== 'ready') {
    return {
      title: 'No slicer found',
      text: 'You can still design parts and get assembly guides. You won’t get print-ready 3MF files until Bambu Studio is installed.',
      go: 'without-slicer',
    }
  }
  return { title: 'Your Mac is ready', text: 'Everything the app needs is here.', go: 'ready' }
}

/** Setup's check of the Mac: a row for each sign-in, Bambu Studio, uv, and Python. */
export default function SetupCheck({ next, onError, signIn, signIns }: StepProps) {
  const [found, setFound] = useState<Found>({})
  const [round, setRound] = useState(0)
  const [keyFormFor, setKeyFormFor] = useState<ProviderId | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setFound({})
    setCopied(null)
    void sidecar('setup.tools', {})
      .then((toolchain) => current && setFound((now) => ({ ...now, toolchain })))
      .catch((err: unknown) => current && onError(String(err)))
    void checkSlicer()
      .then((slicer) => current && setFound((now) => ({ ...now, slicer })))
      .catch((err: unknown) => current && onError(String(err)))
    return () => {
      current = false
    }
  }, [round])

  useEffect(() => {
    let current = true
    void sidecar('auth.status', {})
      .then((logins) => current && setFound((now) => ({ ...now, logins })))
      .catch((err: unknown) => current && onError(String(err)))
    return () => {
      current = false
    }
  }, [round, signIns])

  const verdict = verdictOf(found)
  const copy = (command: string) =>
    void navigator.clipboard.writeText(command).then(
      () => setCopied(command),
      () => onError(`The command could not be copied. Run this in Terminal: ${command}`),
    )

  const actionOf = (action: Action | undefined) => {
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

  const group = (title: string, rows: Row[], after?: ReactNode) => (
    <section className="setup-group" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="setup-row" data-status={row.status} data-testid={`check-${row.id}`}>
            <span className="setup-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: row.icon }} />
            <span className="setup-what">
              <span className="setup-name">{row.name}</span>
              <span className="setup-detail">{row.detail}</span>
            </span>
            <span className="setup-act">{actionOf(row.action)}</span>
            <span className="setup-status">{row.label}</span>
          </li>
        ))}
      </ul>
      {after}
    </section>
  )

  return (
    <>
      <h1>{verdict.title}</h1>
      {verdict.text !== undefined && <p>{verdict.text}</p>}
      {group(
        'Agent that does the work (at least one)',
        agentRows(found.logins),
        <>
          {keyFormFor !== null && found.logins !== undefined && !signedIn(found.logins, keyFormFor) && (
            <div className="setup-key">
              <KeyForm provider={keyFormFor} onError={onError} />
            </div>
          )}
          {signIn}
        </>,
      )}
      {group('Slicer (makes the 3MF)', [slicerRow(found.slicer)])}
      {group('Build tools (required)', buildRows(found.toolchain))}
      {verdict.hint !== undefined && <p className="setup-hint">{verdict.hint}</p>}
      <div className="setup-actions">
        {verdict.go !== 'wait' && (
          <button type="button" onClick={() => setRound(round + 1)}>
            Check again
          </button>
        )}
        <button type="button" className="primary" disabled={verdict.go === 'wait' || verdict.go === 'blocked'} onClick={next}>
          {verdict.go === 'without-slicer' ? 'Continue without a slicer' : 'Continue'}
        </button>
      </div>
    </>
  )
}
