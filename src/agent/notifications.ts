import { listen } from '@tauri-apps/api/event'
import { getAgent } from './agent'
import { useSettingsStore } from '../stores/settings'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProactiveNotificationPayload {
  event_type: 'print_complete' | 'print_failed'
  model_name: string
  printer_name: string
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

/** Cooldown period: same event_type within 60s is suppressed. */
export const DEDUP_COOLDOWN_MS = 60_000

/** Tracks last-fired timestamp per event_type for dedup. Exported for test inspection. */
export const lastFiredMap = new Map<string, number>()

/**
 * Returns true if an event of this type was already fired within the cooldown window.
 */
export function isDuplicate(eventType: string): boolean {
  const last = lastFiredMap.get(eventType)
  if (last == null) return false
  return Date.now() - last < DEDUP_COOLDOWN_MS
}

/**
 * Record that an event of this type was just fired.
 */
export function recordFired(eventType: string): void {
  lastFiredMap.set(eventType, Date.now())
}

/**
 * Clear all dedup state. Intended for test cleanup.
 */
export function resetDedup(): void {
  lastFiredMap.clear()
}

// ─── Message Builder ──────────────────────────────────────────────────────────

function buildMessage(payload: ProactiveNotificationPayload): string {
  if (payload.event_type === 'print_complete') {
    return `[Printer Event] Your print "${payload.model_name}" on ${payload.printer_name} has completed successfully.`
  }
  return `[Printer Event] Your print "${payload.model_name}" on ${payload.printer_name} has failed.`
}

// ─── Listener Setup ───────────────────────────────────────────────────────────

/**
 * Subscribe to `proactive:notification` Tauri events and route them to the agent.
 *
 * Returns an unlisten function for cleanup (call in useEffect teardown).
 *
 * Pipeline:
 *   1. Settings gate — skip if notification preference is disabled
 *   2. Dedup gate — skip if same event_type fired within DEDUP_COOLDOWN_MS
 *   3. Build user message
 *   4. Route to agent: prompt() if idle, followUp() if streaming
 */
export async function setupProactiveNotifications(): Promise<() => void> {
  const unlisten = await listen<ProactiveNotificationPayload>(
    'proactive:notification',
    (event) => {
      const { payload } = event

      // 1. Settings gate
      const settingKey = `notifications.${payload.event_type}`
      const enabled = useSettingsStore.getState().getSettingBool(settingKey)
      if (!enabled) {
        console.debug('agent:proactive-suppressed-by-setting', settingKey)
        return
      }

      // 2. Dedup gate
      if (isDuplicate(payload.event_type)) {
        console.debug('agent:proactive-dedup-suppressed', payload.event_type)
        return
      }
      recordFired(payload.event_type)

      // 3. Build message
      const message = buildMessage(payload)

      // 4. Route to agent
      const agent = getAgent()
      if (agent.state.isStreaming) {
        agent.followUp({ role: 'user', content: message, timestamp: Date.now() })
        console.debug('agent:proactive-followup', payload.event_type)
      } else {
        agent.prompt(message)
        console.debug('agent:proactive-prompt', payload.event_type)
      }
    }
  )

  return unlisten
}
