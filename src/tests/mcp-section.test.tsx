import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

import { McpSection, claudeMcpAddCommand } from '../components/McpSection'

describe('McpSection', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('is off until the person enables it, then shows the local URL', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'mcp_status') return { running: false, url: null }
      if (cmd === 'mcp_set_enabled') return { running: true, url: 'http://127.0.0.1:45373/mcp' }
      throw new Error(`unexpected ${cmd}`)
    })
    render(<McpSection active />)
    const toggle = await screen.findByTestId('mcp-enabled')
    expect((toggle as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByTestId('mcp-url')).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByTestId('mcp-url').textContent).toBe('http://127.0.0.1:45373/mcp'))
    expect(invokeMock).toHaveBeenCalledWith('mcp_set_enabled', { enabled: true })
  })

  it('copies a Claude Code command carrying the token only on request', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'mcp_status') return { running: true, url: 'http://127.0.0.1:45373/mcp' }
      if (cmd === 'mcp_token') return 'tok-abc'
      throw new Error(`unexpected ${cmd}`)
    })
    render(<McpSection active />)
    fireEvent.click(await screen.findByTestId('mcp-copy-command'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText).toHaveBeenCalledWith(claudeMcpAddCommand('http://127.0.0.1:45373/mcp', 'tok-abc'))
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'mcp_token')).toHaveLength(1)
  })
})
