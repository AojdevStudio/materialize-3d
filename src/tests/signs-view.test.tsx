// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifacts, RecordedCheck, SignRevision } from '../types/signs'

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

import { SignsView } from '../components/signs/SignsView'
import { SIGNS_DEFAULT_STATE, useSignsEvents, useSignsStore } from '../stores/signs'

const PACKAGE_SHA = 'abc123f09e2d7b41c8a5e6f2d3b4c5a6e7f8091a2b3c4d5e6f708192a3b4c4e7'
const GCODE_SHA = '7f3a91c2e4d5b6a7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d0d1b'

const PASSING: RecordedCheck[] = [
  { id: 'geometry.closed_manifold.base', passed: true, detail: 'closed' },
  { id: 'geometry.closed_manifold.navy', passed: true, detail: 'closed' },
  { id: 'slice.slice_succeeded', passed: true, detail: 'exit 0, return_code 0, 1 plate(s)' },
  { id: 'slice.placement_preserved', passed: true, detail: 'max deviation 0.48 mm' },
  { id: 'handoff.settings_match_slice', passed: true, detail: 'package settings and colors match the verified slice' },
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

function revision(overrides: Partial<SignRevision> = {}): SignRevision {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    lineage_id: '22222222-2222-4222-8222-222222222222',
    number: 2,
    parent_id: null,
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

/** A backend holding one revision; `sign_approve` returns `approved` when given. */
function backend(current: SignRevision, approved?: SignRevision) {
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'sign_list':
        return [current]
      case 'sign_get':
        return current
      case 'sign_lineage':
        return [current]
      case 'sign_preview':
        return new ArrayBuffer(8)
      case 'sign_approve':
        return approved
      case 'set_active_view':
        return {}
      default:
        throw new Error(`unexpected command ${command}`)
    }
  })
}

async function openRevision(current: SignRevision, approved?: SignRevision) {
  backend(current, approved)
  render(<SignsView />)
  fireEvent.click(await screen.findByTestId('sign-revision-row'))
  return screen.findByTestId('sign-detail')
}

const text = (testId: string) => screen.getByTestId(testId).textContent ?? ''
/** The value cell of one axis row, without its label. */
const axis = (testId: string) => screen.getByTestId(testId).querySelector('td')?.textContent ?? ''

beforeEach(() => {
  invokeMock.mockReset()
  listeners.clear()
  useSignsStore.setState(SIGNS_DEFAULT_STATE)
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => cleanup())

describe('Signs view', () => {
  it('disables Approve for a failed build and shows the failing check', async () => {
    const failing = [...PASSING.slice(0, 3), { id: 'slice.placement_preserved', passed: false, detail: 'tool 1 off by 3.10 mm' }]
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

  it('approves with exactly the package hash the button displays', async () => {
    const pending = revision()
    await openRevision(pending, revision({ approval: { status: 'approved', package_sha256: PACKAGE_SHA, at: '2026-09-25T14:20:00Z' } }))

    const approve = screen.getByTestId('btn-approve') as HTMLButtonElement
    expect(approve.textContent).toBe('Approve r2 for abc123f…c4e7')
    fireEvent.click(approve)

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sign_approve', { id: pending.id, packageSha256: PACKAGE_SHA }))
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
    await openRevision(revision(), revision({ approval: { status: 'approved', package_sha256: PACKAGE_SHA, at: '2026-09-25T14:20:00Z' } }))

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

  it('opens the revision named by a signs:open event in the Signs view', async () => {
    const target = revision()
    backend(target)
    function Harness() {
      useSignsEvents()
      return <SignsView />
    }
    render(<Harness />)
    await waitFor(() => expect(listeners.has('signs:open')).toBe(true))

    act(() => listeners.get('signs:open')?.({ payload: { revisionId: target.id } }))

    await screen.findByTestId('sign-detail')
    expect(invokeMock).toHaveBeenCalledWith('set_active_view', { view: 'signs' })
    expect(invokeMock).toHaveBeenCalledWith('sign_get', { id: target.id })
  })
})
