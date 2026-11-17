// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type Blocker, lockedText, type SetupCause, SetupBanner } from './Waiting'

afterEach(cleanup)

const blockers: Blocker[] = [
  { kind: 'login', provider: 'anthropic', name: 'Anthropic', fix: 'Sign in to Anthropic before you send.' },
  { kind: 'turn-login', provider: 'openai-codex', name: 'OpenAI Codex' },
  { kind: 'uv', fix: 'Install uv.' },
  { kind: 'python', fix: 'Install Python.' },
  { kind: 'model', fix: 'Choose a model from Anthropic, OpenAI Codex. The app does not offer faux.' },
]

describe('what keeps Send off', () => {
  it.each(blockers.map((blocker) => [blocker.kind, blocker] as const))('lockedText for %s', (_kind, blocker) => {
    expect(lockedText(blocker)).toBe(
      {
        login: 'Log in to an agent to send',
        'turn-login': 'Log in to an agent to send',
        uv: 'Install uv to send',
        python: 'Install Python to send',
        model: 'Choose a model to send',
      }[blocker.kind],
    )
  })
})

describe('SetupBanner', () => {
  const causes: [SetupCause, string, boolean][] = [
    [blockers[0]!, 'Claude is logged out. Your chats are saved. Log in to keep working.', true],
    [{ kind: 'login', provider: 'opencode-go', name: 'OpenCode Go', fix: '' }, 'OpenCode Go is logged out. Your chats are saved. Log in to keep working.', true],
    [blockers[1]!, 'ChatGPT needs a new login. Your chats are saved, and the message picks up where it stopped.', true],
    [blockers[2]!, 'uv is missing. Your chats are saved. Install it to keep working.', true],
    [blockers[3]!, 'Python is missing. Your chats are saved. Install it to keep working.', true],
    [blockers[4]!, 'Choose a model from Anthropic, OpenAI Codex. The app does not offer faux.', false],
    [{ kind: 'slicer' }, 'No slicer found. You can still design parts, but you won’t get print-ready 3MF files.', true],
  ]

  it.each(causes.map(([cause, text, fix]) => [cause.kind, cause, text, fix] as const))('says what %s needs', (_kind, cause, text, fix) => {
    const onFix = vi.fn()
    render(<SetupBanner cause={cause} onFix={onFix} />)
    const banner = screen.getByTestId('setup-needed')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.querySelector('span')?.textContent).toBe(text)
    const button = screen.queryByRole('button', { name: 'Fix in setup' })
    expect(button !== null).toBe(fix)
    if (button !== null) fireEvent.click(button)
    expect(onFix).toHaveBeenCalledTimes(fix ? 1 : 0)
  })
})
