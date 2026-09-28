// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Hoisted mocks (vi.mock is hoisted, so shared state must be too) ─────────

const { listenMock, mockAgent } = vi.hoisted(() => {
  const listenMock = vi.fn()
  const mockAgent = {
    state: { isStreaming: false },
    prompt: vi.fn(),
    followUp: vi.fn(),
  }
  return { listenMock, mockAgent }
})

// ─── Tauri mocks ──────────────────────────────────────────────────────────────

type ListenerCallback = (event: { payload: any }) => void
const registeredListeners = new Map<string, ListenerCallback[]>()

listenMock.mockImplementation(async (eventName: string, callback: ListenerCallback) => {
  if (!registeredListeners.has(eventName)) {
    registeredListeners.set(eventName, [])
  }
  registeredListeners.get(eventName)!.push(callback)
  return () => {
    const cbs = registeredListeners.get(eventName)
    if (cbs) {
      const idx = cbs.indexOf(callback)
      if (idx >= 0) cbs.splice(idx, 1)
    }
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// ─── Agent mock ───────────────────────────────────────────────────────────────

vi.mock('../agent/agent', () => ({
  getAgent: vi.fn(() => mockAgent),
}))

// ─── Pi SDK mocks (needed transitively by agent) ─────────────────────────────

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
}))

vi.mock('@mariozechner/pi-web-ui', () => ({
  defaultConvertToLlm: vi.fn(),
  AppStorage: vi.fn(),
  IndexedDBStorageBackend: vi.fn(),
  SettingsStore: vi.fn(() => ({ getConfig: vi.fn() })),
  ProviderKeysStore: vi.fn(() => ({ getConfig: vi.fn(), get: vi.fn() })),
  SessionsStore: Object.assign(vi.fn(() => ({ getConfig: vi.fn() })), {
    getMetadataConfig: vi.fn(),
  }),
  CustomProvidersStore: vi.fn(() => ({ getConfig: vi.fn() })),
  setAppStorage: vi.fn(),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { useSettingsStore, SETTINGS_DEFAULT_STATE } from '../stores/settings'
import {
  isDuplicate,
  recordFired,
  resetDedup,
  lastFiredMap,
  DEDUP_COOLDOWN_MS,
  setupProactiveNotifications,
  type ProactiveNotificationPayload,
} from '../agent/notifications'

function emitEvent(payload: ProactiveNotificationPayload) {
  const listeners = registeredListeners.get('proactive:notification') ?? []
  for (const cb of listeners) {
    cb({ payload })
  }
}

const COMPLETE_PAYLOAD: ProactiveNotificationPayload = {
  event_type: 'print_complete',
  model_name: 'Test Cube',
  printer_name: 'P2S',
}

const FAILED_PAYLOAD: ProactiveNotificationPayload = {
  event_type: 'print_failed',
  model_name: 'Benchy',
  printer_name: 'AOJDevStudio',
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('proactive notifications: dedup logic', () => {
  beforeEach(() => {
    resetDedup()
  })

  it('isDuplicate returns false on first call for an event type', () => {
    expect(isDuplicate('print_complete')).toBe(false)
  })

  it('isDuplicate returns true within cooldown after recordFired', () => {
    recordFired('print_complete')
    expect(isDuplicate('print_complete')).toBe(true)
  })

  it('isDuplicate returns false after cooldown expires', () => {
    const realNow = Date.now
    const now = realNow()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    recordFired('print_complete')

    // Advance past cooldown
    vi.spyOn(Date, 'now').mockReturnValue(now + DEDUP_COOLDOWN_MS + 1)
    expect(isDuplicate('print_complete')).toBe(false)

    // Restore Date.now to avoid polluting other tests
    vi.mocked(Date.now).mockRestore()
  })

  it('dedup is per event_type — different types are independent', () => {
    recordFired('print_complete')
    expect(isDuplicate('print_complete')).toBe(true)
    expect(isDuplicate('print_failed')).toBe(false)
  })

  it('resetDedup clears all entries so next event fires', () => {
    recordFired('print_complete')
    recordFired('print_failed')
    expect(lastFiredMap.size).toBe(2)

    resetDedup()
    expect(lastFiredMap.size).toBe(0)
    expect(isDuplicate('print_complete')).toBe(false)
    expect(isDuplicate('print_failed')).toBe(false)
  })
})

describe('proactive notifications: listener behavior', () => {
  let unlisten: (() => void) | null = null

  beforeEach(async () => {
    registeredListeners.clear()
    resetDedup()
    mockAgent.state.isStreaming = false
    mockAgent.prompt.mockReset()
    mockAgent.followUp.mockReset()
    listenMock.mockClear()

    // Set notification settings to enabled (default)
    useSettingsStore.setState({
      ...SETTINGS_DEFAULT_STATE,
      settings: {
        'notifications.print_complete': 'true',
        'notifications.print_failed': 'true',
      },
      loaded: true,
    })

    unlisten = await setupProactiveNotifications()
  })

  afterEach(() => {
    unlisten?.()
    unlisten = null
  })

  it('registers a listener for proactive:notification', () => {
    expect(listenMock).toHaveBeenCalledWith('proactive:notification', expect.any(Function))
  })

  it('settings gate: skips when getSettingBool returns false', () => {
    useSettingsStore.setState({
      settings: {
        'notifications.print_complete': 'false',
        'notifications.print_failed': 'true',
      },
      loaded: true,
    })

    emitEvent(COMPLETE_PAYLOAD)

    expect(mockAgent.prompt).not.toHaveBeenCalled()
    expect(mockAgent.followUp).not.toHaveBeenCalled()
  })

  it('settings gate: proceeds when getSettingBool returns true', () => {
    emitEvent(COMPLETE_PAYLOAD)

    expect(mockAgent.prompt).toHaveBeenCalledTimes(1)
  })

  it('idle routing: calls agent.prompt() when not streaming', () => {
    mockAgent.state.isStreaming = false
    emitEvent(COMPLETE_PAYLOAD)

    expect(mockAgent.prompt).toHaveBeenCalledTimes(1)
    expect(mockAgent.followUp).not.toHaveBeenCalled()

    const msg = mockAgent.prompt.mock.calls[0][0]
    expect(msg).toContain('[Printer Event]')
    expect(msg).toContain('Test Cube')
    expect(msg).toContain('P2S')
    expect(msg).toContain('completed successfully')
  })

  it('streaming routing: calls agent.followUp() when streaming', () => {
    mockAgent.state.isStreaming = true
    emitEvent(FAILED_PAYLOAD)

    expect(mockAgent.followUp).toHaveBeenCalledTimes(1)
    expect(mockAgent.prompt).not.toHaveBeenCalled()

    const msg = mockAgent.followUp.mock.calls[0][0]
    expect(msg).toEqual({
      role: 'user',
      content: expect.stringContaining('[Printer Event]'),
      timestamp: expect.any(Number),
    })
    expect(msg.content).toContain('Benchy')
    expect(msg.content).toContain('AOJDevStudio')
    expect(msg.content).toContain('failed')
  })

  it('message format: includes model name and printer name for print_complete', () => {
    emitEvent(COMPLETE_PAYLOAD)

    const msg = mockAgent.prompt.mock.calls[0][0]
    expect(msg).toBe(
      '[Printer Event] Your print "Test Cube" on P2S has completed successfully.'
    )
  })

  it('message format: includes model name and printer name for print_failed', () => {
    emitEvent(FAILED_PAYLOAD)

    const msg = mockAgent.prompt.mock.calls[0][0]
    expect(msg).toBe(
      '[Printer Event] Your print "Benchy" on AOJDevStudio has failed.'
    )
  })

  it('dedup: second event of same type within cooldown is suppressed', () => {
    emitEvent(COMPLETE_PAYLOAD)
    emitEvent(COMPLETE_PAYLOAD)

    expect(mockAgent.prompt).toHaveBeenCalledTimes(1)
  })

  it('dedup: different event types are not suppressed', () => {
    emitEvent(COMPLETE_PAYLOAD)
    emitEvent(FAILED_PAYLOAD)

    expect(mockAgent.prompt).toHaveBeenCalledTimes(2)
  })

  it('unlisten stops the listener', async () => {
    unlisten!()

    emitEvent(COMPLETE_PAYLOAD)

    expect(mockAgent.prompt).not.toHaveBeenCalled()
    unlisten = null // prevent double-unlisten in afterEach
  })
})
