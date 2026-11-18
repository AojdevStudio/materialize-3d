import type { Login, ProviderId, Toolchain } from '../../sidecar/src/protocol'
import bambu from '../assets/icons/bambu-studio.svg?raw'
import python from '../assets/icons/python.svg?raw'
import uv from '../assets/icons/uv.svg?raw'
import { AGENTS } from './agents'
import type { SlicerCheck } from './api'

/** Each part of the check: its answer, or `failed`. A part still being checked is missing. */
export type Found = { logins?: Login[] | 'failed'; toolchain?: Toolchain | 'failed'; slicer?: SlicerCheck | 'failed' }

type Status = 'checking' | 'failed' | 'ready' | 'needs' | 'required-missing' | 'optional-missing'
export type Action = { kind: 'signIn'; provider: ProviderId; key: boolean } | { kind: 'copy'; command: string }
export type Row = { id: string; name: string; icon: string; status: Status; label: string; detail: string; action?: Action }

const INSTALL_UV = 'curl -LsSf https://astral.sh/uv/install.sh | sh'
const INSTALL_PYTHON = 'uv python install'

const loginOf = (logins: Login[], provider: ProviderId) => logins.find((login) => login.provider === provider)
export const signedIn = (logins: Login[], provider: ProviderId) => (loginOf(logins, provider)?.login ?? null) !== null

/** A row whose part has not answered yet, or whose check failed. */
const unanswered = (row: Pick<Row, 'id' | 'name' | 'icon'>, failed: boolean, lookingFor: string): Row =>
  failed
    ? { ...row, status: 'failed', label: 'Not checked', detail: 'The check failed. Press Check again.' }
    : { ...row, status: 'checking', label: 'Checking', detail: `Looking for ${lookingFor}…` }

/** A sign-in that a waiting turn was refused with counts as signed out, so its row offers the fix. */
export const forgetRefused = (found: Found, refused: string | undefined): Found =>
  Array.isArray(found.logins)
    ? { ...found, logins: found.logins.map((login) => (login.provider === refused ? { ...login, login: null } : login)) }
    : found

export function agentRows(logins: Found['logins'], refused: string | undefined): Row[] {
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

export function slicerRow(slicer: Found['slicer']): Row {
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

export function buildRows(toolchain: Found['toolchain']): Row[] {
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
