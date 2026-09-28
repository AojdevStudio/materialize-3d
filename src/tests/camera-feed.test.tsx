// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}))

import { usePrinterStore, PRINTER_DEFAULT_STATE } from '../stores/printer'
import { CameraFeed } from '../components/CameraFeed'

describe('CameraFeed', () => {
  beforeEach(() => {
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders placeholder when status is unavailable', () => {
    usePrinterStore.setState({
      cameraState: {
        status: 'unavailable',
        url: null,
        diagnostic: 'P2S camera not enabled (ipcam_dev=0)',
      },
    })

    render(React.createElement(CameraFeed))

    expect(screen.getByTestId('camera-feed')).toBeDefined()
    expect(screen.getByText('Camera Unavailable')).toBeDefined()
    expect(screen.getByTestId('camera-off-icon')).toBeDefined()
    expect(screen.getByTestId('camera-diagnostic').textContent).toBe(
      'P2S camera not enabled (ipcam_dev=0)',
    )
  })

  it('renders image when status is available with URL', () => {
    usePrinterStore.setState({
      cameraState: {
        status: 'available',
        url: 'http://192.0.2.136:6000/',
        diagnostic: null,
      },
    })

    render(React.createElement(CameraFeed))

    const img = screen.getByTestId('camera-image') as HTMLImageElement
    expect(img).toBeDefined()
    expect(img.src).toContain('http://192.0.2.136:6000/')
    expect(screen.getByTestId('camera-refresh')).toBeDefined()
    expect(screen.getByText('Camera Feed')).toBeDefined()
  })

  it('shows diagnostic message when unavailable', () => {
    usePrinterStore.setState({
      cameraState: {
        status: 'error',
        url: null,
        diagnostic: 'Camera endpoint returned HTTP 500',
      },
    })

    render(React.createElement(CameraFeed))

    expect(screen.getByText('Camera Unavailable')).toBeDefined()
    expect(screen.getByTestId('camera-diagnostic').textContent).toBe(
      'Camera endpoint returned HTTP 500',
    )
  })

  it('handles probing state with pulsing indicator', () => {
    usePrinterStore.setState({
      cameraState: {
        status: 'probing',
        url: null,
        diagnostic: 'Probing camera endpoint...',
      },
    })

    render(React.createElement(CameraFeed))

    expect(screen.getByTestId('camera-probing')).toBeDefined()
    expect(screen.getByText('Checking camera...')).toBeDefined()
    expect(screen.getByText('Probing camera endpoint...')).toBeDefined()
  })

  it('renders placeholder with no diagnostic when diagnostic is null', () => {
    usePrinterStore.setState({
      cameraState: {
        status: 'unavailable',
        url: null,
        diagnostic: null,
      },
    })

    render(React.createElement(CameraFeed))

    expect(screen.getByText('Camera Unavailable')).toBeDefined()
    expect(screen.queryByTestId('camera-diagnostic')).toBeNull()
  })
})
