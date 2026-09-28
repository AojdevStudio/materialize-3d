import { useEffect, useRef, useState } from 'react'
import { ChatPanel as PiChatPanel, ApiKeyPromptDialog } from '@mariozechner/pi-web-ui'
import { getAgent } from '../agent/agent'
import type { Agent } from '@mariozechner/pi-agent-core'
import '../styles/pi-chat.css'

/**
 * React wrapper that imperatively mounts the pi-web-ui ChatPanel Lit component.
 *
 * Lifecycle:
 * 1. On mount: gets Agent singleton via getAgent(), instantiates PiChatPanel Lit element,
 *    wires it with setAgent() + API key prompt, appends to container div.
 * 2. On unmount: removes the Lit element from the DOM.
 *
 * CSS scoping: the container has className="pi-chat-container dark" which activates
 * pi-web-ui's dark theme and applies our token overrides from pi-chat.css.
 */
export function ChatPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const litPanelRef = useRef<PiChatPanel | null>(null)
  const agentRef = useRef<Agent | null>(null)
  const [providerName, setProviderName] = useState('Claude')
  const [mountError, setMountError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false

    async function mount() {
      try {
        // Get the singleton agent instance
        const agent = getAgent()
        agentRef.current = agent

        // Expose agent for dev debugging
        if (import.meta.env.DEV) {
          ;(window as any).__MATERIALIZE_AGENT__ = agent
        }

        // Read provider name from agent model
        const model = agent.state.model
        if (model?.provider) {
          const name = model.provider.charAt(0).toUpperCase() + model.provider.slice(1)
          setProviderName(name)
        }

        if (disposed) return

        // Create and configure the Lit ChatPanel
        const panel = new PiChatPanel()
        litPanelRef.current = panel

        await panel.setAgent(agent, {
          onApiKeyRequired: async (provider: string) => {
            return ApiKeyPromptDialog.prompt(provider)
          },
        })

        if (disposed) return

        // Mount the Lit element into the container
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        container!.appendChild(panel as unknown as Node)
        console.debug('agent:chat-panel-mounted')
      } catch (err) {
        console.error('agent:chat-panel-mount-failed', err)
        if (!disposed) {
          setMountError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    mount()

    return () => {
      disposed = true

      // Clean up the Lit element
      const panel = litPanelRef.current
      if (panel && container.contains(panel as unknown as Node)) {
        container.removeChild(panel as unknown as Node)
      }
      litPanelRef.current = null

      // Agent singleton persists across mount/unmount — don't null it

      console.debug('agent:chat-panel-unmounted')
    }
  }, [])

  return (
    <aside className="chat-panel" aria-label="AI assistant panel">
      <div className="chat-header">
        <h2 className="chat-title">AI Assistant</h2>
        <span className="provider-badge">{providerName}</span>
      </div>

      <div
        ref={containerRef}
        className="pi-chat-container dark"
        style={{ flex: 1, minHeight: 0 }}
      >
        {mountError && (
          <div
            style={{
              padding: '16px',
              color: 'var(--accent-red)',
              fontSize: '13px',
            }}
          >
            Failed to mount chat panel: {mountError}
          </div>
        )}
      </div>
    </aside>
  )
}

export default ChatPanel
