// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.2.1') }))

import { AboutSection } from '../components/AboutSection'
import { UpdateBanner } from '../components/UpdateBanner'
import {
  checkForUpdates,
  checkForUpdatesAtLaunch,
  resetUpdateStoreForTests,
  type UpdateCheck,
} from '../stores/updates'

const NEWER: UpdateCheck = {
  status: 'available',
  currentVersion: '0.2.1',
  version: '0.3.0',
  notes: 'Auto-update arrives.',
  date: '2026-11-01T12:00:00Z',
}
const CURRENT: UpdateCheck = { status: 'upToDate', currentVersion: '0.2.1' }

function feed(check: UpdateCheck | Error, install: () => Promise<unknown> = async () => undefined) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'update_check') {
      if (check instanceof Error) throw check.message
      return check
    }
    if (cmd === 'update_install') return install()
    throw new Error(`unexpected ${cmd}`)
  })
}

const installCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === 'update_install')

describe('updates', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    resetUpdateStoreForTests()
  })
  afterEach(cleanup)

  it('offers a newer version at launch with its notes, Update now, and Later', async () => {
    feed(NEWER)
    render(<UpdateBanner />)
    await act(() => checkForUpdatesAtLaunch())
    expect(screen.getByTestId('update-version').textContent).toBe('Materialize 3D 0.3.0 is available.')
    expect(screen.getByTestId('update-notes').textContent).toBe('Auto-update arrives.')
    expect(screen.getByTestId('update-now')).toBeTruthy()
    expect(screen.getByTestId('update-later')).toBeTruthy()
    expect(installCalls()).toHaveLength(0)
  })

  it('shows nothing when the running version is the latest', async () => {
    feed(CURRENT)
    render(<UpdateBanner />)
    await act(() => checkForUpdatesAtLaunch())
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })

  it('Later installs nothing and the next launch asks again', async () => {
    feed(NEWER)
    render(<UpdateBanner />)
    await act(() => checkForUpdatesAtLaunch())
    fireEvent.click(screen.getByTestId('update-later'))
    expect(screen.queryByTestId('update-banner')).toBeNull()
    await act(() => checkForUpdatesAtLaunch())
    expect(screen.queryByTestId('update-banner')).toBeNull()
    expect(installCalls()).toHaveLength(0)

    resetUpdateStoreForTests()
    await act(() => checkForUpdatesAtLaunch())
    expect(screen.getByTestId('update-version').textContent).toContain('0.3.0')
  })

  it('Update now installs exactly the offered version', async () => {
    feed(NEWER, () => new Promise(() => {}))
    render(<UpdateBanner />)
    await act(() => checkForUpdatesAtLaunch())
    fireEvent.click(screen.getByTestId('update-now'))
    await waitFor(() => expect(screen.getByTestId('update-now').textContent).toBe('Updating…'))
    fireEvent.click(screen.getByTestId('update-now'))
    expect(installCalls()).toEqual([['update_install', { version: '0.3.0' }]])
  })

  it('a failed install shows the error, keeps the app running, and can be retried', async () => {
    feed(NEWER, async () => {
      throw 'The update did not download or its signature did not verify: signature mismatch'
    })
    render(<UpdateBanner />)
    await act(() => checkForUpdatesAtLaunch())
    fireEvent.click(screen.getByTestId('update-now'))
    await waitFor(() => expect(screen.getByTestId('update-error').textContent).toContain('signature mismatch'))
    expect(screen.getByRole('alert').textContent).toContain('0.3.0 did not install')
    expect(screen.getByRole('alert').textContent).toContain('The current version keeps running.')
    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(installCalls()).toHaveLength(2))
  })

  it('a failed check shows the error and can be dismissed', async () => {
    feed(new Error('Could not check for updates: error sending request'))
    render(<UpdateBanner />)
    await act(() => checkForUpdatesAtLaunch())
    expect(screen.getByTestId('update-error').textContent).toBe('Could not check for updates: error sending request')
    fireEvent.click(screen.getByText('Dismiss'))
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })

  it('a failed recheck reports a check failure, not a failed install', async () => {
    feed(NEWER)
    render(<UpdateBanner />)
    await act(() => checkForUpdatesAtLaunch())
    feed(new Error('Could not check for updates: timed out'))
    await act(() => checkForUpdates())
    expect(screen.getByRole('alert').textContent).toContain('Could not check for updates.')
    expect(screen.getByRole('alert').textContent).not.toContain('did not install')
    expect(installCalls()).toHaveLength(0)
  })

  it('checks once when asked twice at the same time', async () => {
    feed(CURRENT)
    await Promise.all([checkForUpdates(), checkForUpdates(), checkForUpdatesAtLaunch()])
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'update_check')).toHaveLength(1)
  })

  describe('Settings > About', () => {
    it('shows the installed version and reports up to date', async () => {
      feed(CURRENT)
      render(<AboutSection active />)
      await waitFor(() => expect(screen.getByTestId('about-version').textContent).toBe('Materialize 3D 0.2.1'))
      fireEvent.click(screen.getByTestId('about-check'))
      await waitFor(() => expect(screen.getByTestId('about-status').textContent).toBe('Materialize 3D is up to date.'))
    })

    it('reports a newer version and offers Update now', async () => {
      feed(NEWER)
      render(<AboutSection active />)
      fireEvent.click(screen.getByTestId('about-check'))
      await waitFor(() => expect(screen.getByTestId('about-status').textContent).toBe('Version 0.3.0 is available.'))
      fireEvent.click(screen.getByTestId('about-update-now'))
      await waitFor(() => expect(installCalls()).toEqual([['update_install', { version: '0.3.0' }]]))
    })

    it('reports a failed check', async () => {
      feed(new Error('Could not check for updates: 404 Not Found'))
      render(<AboutSection active />)
      fireEvent.click(screen.getByTestId('about-check'))
      await waitFor(() => expect(screen.getByTestId('about-status').textContent).toBe('Could not check for updates: 404 Not Found'))
    })
  })
})
