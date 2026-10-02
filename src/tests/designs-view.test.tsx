// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifacts, RecordedCheck, Revision } from '../types/designs'

type Listener = (event: { payload: unknown }) => void

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, Listener>(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage: (message: unknown) => void = () => {}
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Listener) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))

import { DesignsView } from '../components/designs/DesignsView'
import { DESIGNS_DEFAULT_STATE, useDesignsEvents, useDesignsStore } from '../stores/designs'

const PACKAGE_SHA = 'abc123f09e2d7b41c8a5e6f2d3b4c5a6e7f8091a2b3c4d5e6f708192a3b4c4e7'
const GCODE_SHA = '7f3a91c2e4d5b6a7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d0d1b'

const PASSING: RecordedCheck[] = [
  { id: 'geometry.closed_manifold.base', passed: true, advisory: false, detail: 'closed' },
  { id: 'geometry.closed_manifold.navy', passed: true, advisory: false, detail: 'closed' },
  { id: 'slice.slice_succeeded', passed: true, advisory: false, detail: 'exit 0, return_code 0, 1 plate(s)' },
  { id: 'slice.placement_preserved', passed: true, advisory: false, detail: 'max deviation 0.48 mm' },
  { id: 'handoff.settings_match_slice', passed: true, advisory: false, detail: 'package settings and colors match the verified slice' },
]

function artifacts(checks: RecordedCheck[] = PASSING): Artifacts {
  return {
    revision_dir: '/data/signs/rev',
    package_path: '/data/signs/rev/sign.3mf',
    package_sha256: PACKAGE_SHA,
    preview_path: '/data/signs/rev/preview.png',
    slice_dir: '/data/signs/rev/slice',
    gcode_sha256: GCODE_SHA,
    slicer: { name: 'Bambu Studio', version: '02.08.02.61', profile_version: '02.00.00.52' },
    effective_settings: {
      printer_settings_id: 'Bambu Lab P2S 0.4 nozzle',
      print_settings_id: '0.20mm Standard @BBL P2S',
      filament_settings_id: ['Bambu PLA Basic @BBL P2S', 'Bambu PLA Basic @BBL P2S'],
      filament_colour: ['#FFFFFF', '#1F3A5F'],
      nozzle_diameter: ['0.4'],
      printable_area: [],
      layer_height: '0.2',
      enable_prime_tower: true,
      start_gcode_matches_preset: true,
      start_gcode_in_gcode_header: true,
    },
    checks,
  }
}

function revision(overrides: Partial<Revision> = {}): Revision {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    lineage_id: '22222222-2222-4222-8222-222222222222',
    number: 2,
    parent_id: null,
    kind: 'sign',
    title: 'Back Shortly',
    spec: {
      schema_version: 1,
      width_mm: 150,
      height_mm: 210,
      base: { name: 'white', hex: '#FFFFFF' },
      inks: [{ name: 'navy', hex: '#1F3A5F' }],
      elements: [],
    },
    spec_sha256: 'a'.repeat(64),
    build_id: '33333333-3333-4333-8333-333333333333',
    build_key: 'b'.repeat(64),
    requested_by: 'agent',
    build: { status: 'verified', artifacts: artifacts() },
    approval: { status: 'pending' },
    print_validation: { status: 'not_tested' },
    created_at: '2026-09-25T14:10:00Z',
    updated_at: '2026-09-25T14:12:00Z',
    ...overrides,
  }
}

/** A backend holding one revision; `design_approve` returns `approved` when given. */
function backend(current: Revision, approved?: Revision) {
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'design_list':
        return [current]
      case 'design_get':
        return current
      case 'design_lineage':
        return [current]
      case 'design_preview':
        return new ArrayBuffer(8)
      case 'design_approve':
        return approved
      case 'set_active_view':
        return {}
      default:
        throw new Error(`unexpected command ${command}`)
    }
  })
}

async function openRevision(current: Revision, approved?: Revision) {
  backend(current, approved)
  render(<DesignsView />)
  fireEvent.click(await screen.findByTestId('sign-revision-row'))
  return screen.findByTestId('sign-detail')
}

const text = (testId: string) => screen.getByTestId(testId).textContent ?? ''
/** The value cell of one axis row, without its label. */
const axis = (testId: string) => screen.getByTestId(testId).querySelector('td')?.textContent ?? ''

beforeEach(() => {
  invokeMock.mockReset()
  listeners.clear()
  useDesignsStore.setState(DESIGNS_DEFAULT_STATE)
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => cleanup())

const APPROVED = { status: 'approved', package_sha256: PACKAGE_SHA, acknowledged_warnings: [], at: '2026-09-25T14:20:00Z' } as const

describe('Designs view', () => {
  it('disables Approve for a failed build and shows the failing check', async () => {
    const failing = [...PASSING.slice(0, 3), { id: 'slice.placement_preserved', passed: false, advisory: false, detail: 'tool 1 off by 3.10 mm' }]
    await openRevision(
      revision({ build: { status: 'failed', reason: 'checks failed: slice.placement_preserved', artifacts: artifacts(failing) } }),
    )

    const approve = screen.getByTestId('btn-approve') as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(text('approve-blocked')).toBe('Placement preserved failed: tool 1 off by 3.10 mm')
    expect(screen.getByTestId('sign-checks').querySelector('tbody tr')?.getAttribute('data-check')).toBe(
      'slice.placement_preserved',
    )
  })

  it('approves with exactly the package hash the button displays and no warnings for a sign', async () => {
    const pending = revision()
    await openRevision(pending, revision({ approval: APPROVED }))

    const approve = screen.getByTestId('btn-approve') as HTMLButtonElement
    expect(approve.textContent).toBe('Approve r2 for abc123f…c4e7')
    fireEvent.click(approve)

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('design_approve', { id: pending.id, packageSha256: PACKAGE_SHA, acknowledgedWarnings: [] }),
    )
  })

  it('shows a warning apart from the failures, keeps it out of the count, and acknowledges it on approval', async () => {
    const overhang = { id: 'print.overhang.navy', passed: false, advisory: true, detail: '62 degrees unsupported' }
    const pending = revision({ build: { status: 'verified', artifacts: artifacts([...PASSING, overhang]) } })
    await openRevision(pending, revision({ approval: { ...APPROVED, acknowledged_warnings: [overhang.id] } }))

    const row = screen.getByTestId('sign-checks').querySelector(`tr[data-check="${overhang.id}"]`)
    expect(row?.querySelector('td')?.textContent).toBe('Warning')
    expect(axis('axis-build')).toMatch(/^Yes 5 of 5 checks passed, 1 warning/)
    fireEvent.click(screen.getByTestId('btn-approve'))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('design_approve', {
        id: pending.id,
        packageSha256: PACKAGE_SHA,
        acknowledgedWarnings: [overhang.id],
      }),
    )
  })

  it('renders a void approval as void and offers no export', async () => {
    await openRevision(
      revision({ approval: { status: 'void', reason: 'package changed on disk after approval', at: '2026-09-25T15:00:00Z' } }),
    )

    expect(axis('axis-approval')).toContain('Void')
    expect(axis('axis-approval')).toContain('package changed on disk after approval')
    expect(screen.queryByTestId('btn-export')).toBeNull()
    expect(screen.queryByTestId('btn-approve')).toBeNull()
  })

  it('keeps Print-tested at Not tested after approval', async () => {
    await openRevision(revision(), revision({ approval: APPROVED }))

    fireEvent.click(screen.getByTestId('btn-approve'))

    await screen.findByTestId('btn-export')
    expect(axis('axis-approval')).toContain('Approved')
    expect(axis('axis-print')).toContain('Not tested')
  })

  it('renders each axis from its own state', async () => {
    await openRevision(
      revision({
        approval: { status: 'void', reason: 'package file is missing', at: '2026-09-25T15:00:00Z' },
        print_validation: { status: 'passed', at: '2026-09-25T16:00:00Z', note: 'clean first layer' },
      }),
    )

    expect(axis('axis-build')).toMatch(/^Yes 5 of 5 checks passed/)
    expect(axis('axis-approval')).toMatch(/^Void package file is missing/)
    expect(axis('axis-print')).toMatch(/^Passed .*clean first layer$/)
  })

  it('opens the revision named by a designs:open event in the Signs view', async () => {
    const target = revision()
    backend(target)
    function Harness() {
      useDesignsEvents()
      return <DesignsView />
    }
    render(<Harness />)
    await waitFor(() => expect(listeners.has('designs:open')).toBe(true))

    act(() => listeners.get('designs:open')?.({ payload: { revisionId: target.id } }))

    await screen.findByTestId('sign-detail')
    expect(invokeMock).toHaveBeenCalledWith('set_active_view', { view: 'signs' })
    expect(invokeMock).toHaveBeenCalledWith('design_get', { id: target.id })
  })

  it('shows an invalid build as not verified with its reason, and offers no approval', async () => {
    const reason = 'package changed on disk (now 9f00…) after approval'
    await openRevision(
      revision({
        build: { status: 'invalid', reason, artifacts: artifacts() },
        approval: { status: 'void', reason, at: '2026-09-25T15:00:00Z' },
      }),
    )

    expect(axis('axis-build')).toBe(`No ${reason}`)
    expect(screen.queryByTestId('btn-approve')).toBeNull()
    expect(screen.queryByTestId('btn-export')).toBeNull()
  })
})
