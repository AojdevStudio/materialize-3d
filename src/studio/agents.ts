import { ASTRA_MODEL, type Login, type ModelChoice, type ProviderId } from '../../sidecar/src/protocol'
import claude from '../assets/icons/claude.svg?raw'
import openai from '../assets/icons/openai.svg?raw'

/** The agents setup offers a sign-in to, by the name and icon people know them by. */
export const AGENTS: readonly { id: string; provider: ProviderId; name: string; icon: string }[] = [
  { id: 'claude', provider: 'anthropic', name: 'Claude', icon: claude },
  { id: 'chatgpt', provider: 'openai-codex', name: 'ChatGPT', icon: openai },
]

export const astraSignedIn = (logins: Login[]) => logins.some((login) => login.provider === ASTRA_MODEL.provider && login.login !== null)

export const sameModel = (a: ModelChoice, b: ModelChoice) => a.provider === b.provider && a.modelId === b.modelId
