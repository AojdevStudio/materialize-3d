import { type ReactNode, useEffect, useState } from 'react'
import type { Login, ProviderId, Toolchain } from '../../sidecar/src/protocol'
import bambu from '../assets/icons/bambu-studio.svg?raw'
import claude from '../assets/icons/claude.svg?raw'
import openai from '../assets/icons/openai.svg?raw'
import python from '../assets/icons/python.svg?raw'
import uv from '../assets/icons/uv.svg?raw'
import { checkSlicer, sidecar, type SlicerCheck } from './api'
import type { StepProps } from './Setup'

/** Each part of the check: its answer, or `failed`. A part still being checked is missing. */
type Found = { logins?: Login[] | 'failed'; toolchain?: Toolchain | 'failed'; slicer?: SlicerCheck | 'failed' }

type Status = 'checking' | 'failed' | 'ready' | 'needs' | 'required-missing' | 'optional-missing'
type Action = { kind: 'signIn'; provider: ProviderId; key: boolean } | { kind: 'copy'; command: string }
type Row = { id: string; name: string; icon: string; status: Status; label: string; detail: string; action?: Action }

export const AGENTS: readonly { id: string; provider: ProviderId; name: string; icon: string }[] = [
  { id: 'claude', provider: 'anthropic', name: 'Claude', icon: claude },
  { id: 'chatgpt', provider: 'openai-codex', name: 'ChatGPT', icon: openai },
]

const INSTALL_UV = 'curl -LsSf https://astral.sh/uv/install.sh | sh'
const INSTALL_PYTHON = 'uv python install'
const INSTALL_HINT = 'Paste the install command in Terminal, then press Check again.'

const loginOf = (logins: Login[], provider: ProviderId) => logins.find((login) => login.provider === provider)
const signedIn = (logins: Login[], provider: ProviderId) => (loginOf(logins, provider)?.login ?? null) !== null

/** A row whose part has not answered yet, or whose check failed. */
const unanswered = (row: Pick<Row, 'id' | 'name' | 'icon'>, failed: boolean, lookingFor: string): Row =>
  failed
    ? { ...row, status: 'failed', label: 'Not checked', detail: 'The check failed. Press Check again.' }
    : { ...row, status: 'checking', label: 'Checking', detail: `Looking for ${lookingFor}…` }

function agentRows(logins: Found['logins'], refused: string | undefined): Row[] {
  return AGENTS.map(({ id, provider, name, icon }) => {
    if (logins === undefined || logins === 'failed') return unanswered({ id, name, icon }, logins === 'failed', 'your sign-in')
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
      detail:
        provider === refused
          ? 'Sign in so the waiting message can go on.'
          : other === undefined
            ? 'Not signed in.'
            : `Not signed in. Optional while ${other.name} works.`,
      action: { kind: 'signIn', provider, key: login?.kinds.includes('api_key') ?? false },
    }
  })
}

function slicerRow(slicer: Found['slicer']): Row {
  const row = { id: 'bambu', name: 'Bambu Studio', icon: bambu }
  if (slicer === undefined || slicer === 'failed') return unanswered(row, slicer === 'failed', 'Bambu Studio')
  switch (slicer.found) {
    case 'ready':
      return { ...row, status: 'ready', label: 'Ready', detail: `Version ${slicer.version}.` }
    case 'none':
      return { ...row, status: 'optional-missing', label: 'Not found', detail: 'Not installed. Bambu Studio makes the print-ready 3MF.' }
    case 'other':
      return { ...row, status: 'optional-missing', label: 'Not usable', detail: slicer.detail }
  }
}

function buildRows(toolchain: Found['toolchain']): Row[] {
  const uvRow = { id: 'uv', name: 'uv', icon: uv }
  const pythonRow = { id: 'python', name: 'Python', icon: python }
  if (toolchain === undefined || toolchain === 'failed') {
    return [unanswered(uvRow, toolchain === 'failed', 'uv'), unanswered(pythonRow, toolchain === 'failed', 'Python')]
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

/** Setup's check of the Mac: a row for each sign-in, Bambu Studio, uv, and Python. */
export default function SetupCheck({ next, onError, signIn, signIns, refused }: StepProps) {
  const [found, setFound] = useState<Found>({})
  const [round, setRound] = useState(0)
  const [keyFormFor, setKeyFormFor] = useState<ProviderId | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  /** Fills one part from its answer, or marks it failed, unless the check it belongs to was replaced. */
  const fill = <K extends keyof Found>(part: K, answer: Promise<Exclude<Found[K], 'failed' | undefined>>, current: () => boolean) =>
    void answer.then(
      (value) => current() && setFound((now) => ({ ...now, [part]: value })),
      (err: unknown) => {
        if (!current()) return
        setFound((now) => ({ ...now, [part]: 'failed' }))
        onError(String(err))
      },
    )

  useEffect(() => {
    let current = true
    setFound({})
    setCopied(null)
    fill('toolchain', sidecar('setup.tools', {}), () => current)
    fill('slicer', checkSlicer(), () => current)
    return () => {
      current = false
    }
  }, [round])

  useEffect(() => {
    let current = true
    fill('logins', sidecar('auth.status', {}), () => current)
    return () => {
      current = false
    }
  }, [round, signIns])

  const withoutRefused: Found = Array.isArray(found.logins)
    ? { ...found, logins: found.logins.map((login) => (login.provider === refused ? { ...login, login: null } : login)) }
    : found
  const verdict = verdictOf(withoutRefused)
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
        agentRows(withoutRefused.logins, refused),
        <>
          {keyFormFor !== null && Array.isArray(withoutRefused.logins) && !signedIn(withoutRefused.logins, keyFormFor) && (
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
