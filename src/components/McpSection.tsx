import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface McpStatus {
  running: boolean
  url: string | null
}

/** Builds the command that registers this app as an MCP server in Claude Code. */
export function claudeMcpAddCommand(url: string, token: string): string {
  return `claude mcp add --transport http materialize-3d ${url} --header "Authorization: Bearer ${token}"`
}

/**
 * Local MCP endpoint for external agents. Off by default; the token is read
 * only when the person copies the connection command.
 */
export function McpSection({ active }: { active: boolean }) {
  const [status, setStatus] = useState<McpStatus>({ running: false, url: null })
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!active) return
    invoke<McpStatus>('mcp_status').then(setStatus, (err) => setMessage(String(err)))
  }, [active])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
    } catch (err) {
      setMessage(String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (enabled: boolean) =>
    run(async () => setStatus(await invoke<McpStatus>('mcp_set_enabled', { enabled })))

  const copyCommand = () =>
    run(async () => {
      if (!status.url) return
      const token = await invoke<string>('mcp_token')
      await navigator.clipboard.writeText(claudeMcpAddCommand(status.url, token))
      setMessage('Copied the Claude Code command')
    })

  const rotate = () =>
    run(async () => {
      await invoke<string>('mcp_rotate_token')
      setMessage('New token issued; reconnect external agents')
    })

  return (
    <div className="settings-section" data-testid="mcp-section">
      <div className="settings-section-label">External agents</div>
      <label className="settings-checkbox">
        <input
          type="checkbox"
          checked={status.running}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
          data-testid="mcp-enabled"
        />
        <span>Local MCP endpoint (this computer only, token required)</span>
      </label>
      {status.running && status.url && (
        <>
          <div className="settings-hint" data-testid="mcp-url">{status.url}</div>
          <div className="settings-actions">
            <button type="button" disabled={busy} onClick={() => void copyCommand()} data-testid="mcp-copy-command">
              Copy Claude Code command
            </button>
            <button type="button" disabled={busy} onClick={() => void rotate()} data-testid="mcp-rotate-token">
              Rotate token
            </button>
          </div>
        </>
      )}
      <div className="settings-hint">External agents can build and read signs. Only you can approve them here.</div>
      {message && <div className="settings-hint" data-testid="mcp-message">{message}</div>}
    </div>
  )
}
