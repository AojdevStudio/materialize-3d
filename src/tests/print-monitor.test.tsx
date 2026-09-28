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
import { TemperatureGauge } from '../components/TemperatureGauge'
import { AmsDisplay } from '../components/AmsDisplay'
import { GcodeStateBadge, PrintProgress, PrintMonitor } from '../components/PrintMonitor'

describe('PrintMonitor', () => {
  beforeEach(() => {
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  // --- TemperatureGauge ---

  it('TemperatureGauge renders current and target temps', () => {
    render(React.createElement(TemperatureGauge, { label: 'Nozzle', current: 215, target: 220 }))
    expect(screen.getByText('215°C')).toBeDefined()
    expect(screen.getByText('Target: 220°C')).toBeDefined()
    expect(screen.getByText('Nozzle')).toBeDefined()
  })

  it('TemperatureGauge shows heating indicator when current < target', () => {
    render(React.createElement(TemperatureGauge, { label: 'Nozzle', current: 180, target: 220 }))
    expect(screen.getByTestId('heating-indicator')).toBeDefined()
    expect(screen.getByText('▲ Heating')).toBeDefined()
  })

  it('TemperatureGauge shows at-target indicator when temps match', () => {
    render(React.createElement(TemperatureGauge, { label: 'Bed', current: 60, target: 60 }))
    expect(screen.getByTestId('at-target-indicator')).toBeDefined()
    expect(screen.getByText('● Ready')).toBeDefined()
  })

  it('TemperatureGauge handles null values gracefully', () => {
    render(React.createElement(TemperatureGauge, { label: 'Chamber', current: null, target: null }))
    const gauge = screen.getByTestId('temp-gauge-chamber')
    expect(gauge.querySelector('.temp-gauge-value')?.textContent).toBe('—')
    expect(gauge.querySelector('.temp-gauge-target')?.textContent).toBe('Off')
  })

  // --- AmsDisplay ---

  it('AmsDisplay renders filament slots with correct colors', () => {
    usePrinterStore.setState({
      amsState: [
        {
          id: 0,
          trays: [
            { trayId: 0, trayType: 'PLA', trayColor: 'FF0000' },
            { trayId: 1, trayType: 'PETG', trayColor: '00FF00' },
            { trayId: 2, trayType: null, trayColor: null },
            { trayId: 3, trayType: 'PLA', trayColor: '0000FF' },
          ],
        },
      ],
    })

    render(React.createElement(AmsDisplay))

    const trays = screen.getAllByTestId('ams-tray')
    expect(trays).toHaveLength(4)

    // Verify color swatches
    const swatches = screen.getByTestId('ams-display').querySelectorAll('.ams-swatch')
    expect((swatches[0] as HTMLElement).style.backgroundColor).toBe('rgb(255, 0, 0)')
    expect((swatches[1] as HTMLElement).style.backgroundColor).toBe('rgb(0, 255, 0)')

    // Verify filament type labels
    expect(screen.getAllByText('PLA')).toHaveLength(2)
    expect(screen.getByText('PETG')).toBeDefined()
    expect(screen.getByText('—')).toBeDefined() // empty tray
  })

  it('AmsDisplay shows "No AMS detected" when amsState is empty', () => {
    usePrinterStore.setState({ amsState: [] })
    render(React.createElement(AmsDisplay))
    expect(screen.getByText('No AMS detected')).toBeDefined()
  })

  // --- GcodeStateBadge ---

  it('GcodeStateBadge maps each state to correct visual class', () => {
    const states = [
      { state: 'IDLE', className: 'gcode-badge--idle', label: 'Idle' },
      { state: 'RUNNING', className: 'gcode-badge--running', label: 'Printing' },
      { state: 'PAUSE', className: 'gcode-badge--pause', label: 'Paused' },
      { state: 'FINISH', className: 'gcode-badge--finish', label: 'Finished' },
      { state: 'FAILED', className: 'gcode-badge--failed', label: 'Failed' },
      { state: 'PREPARE', className: 'gcode-badge--prepare', label: 'Preparing' },
    ]

    for (const { state, className, label } of states) {
      cleanup()
      render(React.createElement(GcodeStateBadge, { state }))
      const badge = screen.getByTestId('gcode-badge')
      expect(badge.classList.contains(className)).toBe(true)
      expect(badge.textContent).toBe(label)
    }
  })

  it('GcodeStateBadge handles null state', () => {
    render(React.createElement(GcodeStateBadge, { state: null }))
    const badge = screen.getByTestId('gcode-badge')
    expect(badge.textContent).toBe('Unknown')
    expect(badge.classList.contains('gcode-badge--unknown')).toBe(true)
  })

  // --- PrintProgress ---

  it('PrintProgress renders percentage, layer count, and ETA', () => {
    render(
      React.createElement(PrintProgress, {
        progress: 42,
        layerNum: 100,
        totalLayerNum: 238,
        remainingTime: 125,
        gcodeState: 'RUNNING',
      }),
    )
    expect(screen.getByText('42%')).toBeDefined()
    expect(screen.getByTestId('layer-count').textContent).toBe('Layer 100 / 238')
    expect(screen.getByTestId('remaining-time').textContent).toBe('ETA: 2h 5m')
  })

  it('PrintProgress shows idle state when no print is active', () => {
    render(
      React.createElement(PrintProgress, {
        progress: null,
        layerNum: null,
        totalLayerNum: null,
        remainingTime: null,
        gcodeState: 'IDLE',
      }),
    )
    expect(screen.getByText('No active print')).toBeDefined()
    expect(screen.getByText('—')).toBeDefined() // pct shows dash
  })

  // --- PrintMonitor composition ---

  it('PrintMonitor composes all sub-components', () => {
    usePrinterStore.setState({
      nozzleTemp: 200,
      nozzleTargetTemp: 220,
      bedTemp: 55,
      bedTargetTemp: 60,
      chamberTemp: 35,
      gcodeState: 'RUNNING',
      printProgress: 65,
      layerNum: 150,
      totalLayerNum: 230,
      remainingTime: 45,
      amsState: [
        {
          id: 0,
          trays: [
            { trayId: 0, trayType: 'PLA', trayColor: 'FF6600' },
            { trayId: 1, trayType: 'PETG', trayColor: '3366FF' },
          ],
        },
      ],
    })

    render(React.createElement(PrintMonitor))

    // Verify composition root exists
    expect(screen.getByTestId('print-monitor')).toBeDefined()

    // Temperature gauges
    expect(screen.getByTestId('temp-gauge-nozzle')).toBeDefined()
    expect(screen.getByTestId('temp-gauge-bed')).toBeDefined()
    expect(screen.getByTestId('temp-gauge-chamber')).toBeDefined()
    expect(screen.getByText('200°C')).toBeDefined()

    // Gcode state badge
    expect(screen.getByTestId('gcode-badge')).toBeDefined()
    expect(screen.getByText('Printing')).toBeDefined()

    // Print progress
    expect(screen.getByTestId('print-progress')).toBeDefined()
    expect(screen.getByText('65%')).toBeDefined()

    // AMS
    expect(screen.getByTestId('ams-display')).toBeDefined()
    expect(screen.getByText('PLA')).toBeDefined()
    expect(screen.getByText('PETG')).toBeDefined()

    // Camera feed (default: unavailable placeholder via CameraFeed component)
    expect(screen.getByTestId('camera-feed')).toBeDefined()
  })
})
