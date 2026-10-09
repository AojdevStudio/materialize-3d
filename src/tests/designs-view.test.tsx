// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifacts, PartRevision, RecordedCheck, Revision } from '../types/designs'

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

import { save } from '@tauri-apps/plugin-dialog'

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

const W_OVERHANG: RecordedCheck = {
  id: 'print.overhang.clip',
  passed: false,
  advisory: true,
  detail:
    'about 474 mm² unsupported at z 21.6 mm (750 mm² over all layers); print with supports or turn the part so it rests on a flat face',
}
const W_SUPPORT: RecordedCheck = {
  id: 'slice.support_warning',
  passed: false,
  advisory: true,
  detail: 'plate 1: It seems object part-7ed029a3e87a has floating regions. Please re-orient the object or enable support generation.',
}

/** The part plan for one body and three requirements, every check passing unless replaced. */
function partChecks(replace: RecordedCheck[] = []): RecordedCheck[] {
  const checks: RecordedCheck[] = [
    ...['closed_manifold', 'non_degenerate', 'outward_orientation', 'bounds'].map((name) => ({
      id: `geometry.${name}.clip`,
      passed: true,
      advisory: false,
      detail: 'ok',
    })),
    { id: 'geometry.requirement.0', passed: true, advisory: false, detail: 'Width 22.00 mm (22 ± 0.2)' },
    { id: 'geometry.requirement.1', passed: true, advisory: false, detail: 'Desk opening 18.10 mm (18 ± 0.3)' },
    { id: 'geometry.requirement.2', passed: true, advisory: false, detail: 'Clamp wall 3.60 mm (at least 3)' },
    { id: 'print.overhang.clip', passed: true, advisory: true, detail: 'every layer rests on the one below it' },
    { id: 'slice.slice_succeeded', passed: true, advisory: false, detail: 'exit 0' },
    { id: 'handoff.settings_match_slice', passed: true, advisory: false, detail: 'match' },
    { id: 'slice.support_warning', passed: true, advisory: true, detail: 'no support warning' },
  ]
  return checks.map((check) => replace.find((next) => next.id === check.id) ?? check)
}

function part(overrides: Partial<PartRevision> = {}): PartRevision {
  const base = revision()
  return {
    ...base,
    number: 3,
    kind: 'part',
    title: 'Desk-edge cable clip',
    spec: {
      schema_version: 1,
      title: 'Desk-edge cable clip',
      source: 'from build123d import *',
      params: { desk: 18 },
      requirements: [
        { measure: 'span', name: 'Width', axis: 'x', mm: 22, tol: 0.2 },
        { measure: 'opening', name: 'Desk opening', axis: 'z', at: [11, 10, 12], mm: 18, tol: 0.3 },
        { measure: 'min_wall', name: 'Clamp wall', at: [11, 1.5, 12], mm: 3 },
      ],
      filaments: [{ slot: 1, name: 'Black' }],
    },
    build: { status: 'verified', artifacts: { ...artifacts(partChecks()), package_path: '/data/rev/part.3mf' } },
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
      case 'design_export':
        return '/Users/me/Desktop/Desk-edge cable clip-r3.3mf'
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

  it('opens a part from a designs:open event in its own view, which a sign view would crash on', async () => {
    const target = part()
    backend(target)
    function Harness() {
      useDesignsEvents()
      return <DesignsView />
    }
    render(<Harness />)
    await waitFor(() => expect(listeners.has('designs:open')).toBe(true))

    act(() => listeners.get('designs:open')?.({ payload: { revisionId: target.id } }))

    const detail = await screen.findByTestId('part-detail')
    expect(detail.textContent).toContain('r3 of Desk-edge cable clip')
    expect(screen.queryByTestId('sign-detail')).toBeNull()
    expect(screen.queryByTestId('part-pending')).toBeNull()
  })

  it('never shows the previous revision\'s face beside the next sign revision while its preview loads', async () => {
    const r1 = revision({ id: '66666666-6666-4666-8666-666666666666', number: 1 })
    const r2 = revision({ id: '77777777-7777-4777-8777-777777777777', number: 2 })
    let blobs = 0
    URL.createObjectURL = vi.fn(() => `blob:view-${++blobs}`)
    invokeMock.mockImplementation(async (command: string, args?: { id?: string }) => {
      switch (command) {
        case 'design_list':
          return [r1]
        case 'design_lineage':
          return [r2, r1]
        case 'design_get':
          return args?.id === r2.id ? r2 : r1
        case 'design_preview':
          // r2's face never arrives, so whatever shows beside r2 came from r1.
          return args?.id === r1.id ? new ArrayBuffer(8) : new Promise(() => {})
        default:
          throw new Error(`unexpected command ${command}`)
      }
    })
    render(<DesignsView />)
    fireEvent.click(await screen.findByTestId('sign-revision-row'))
    const detail = await screen.findByTestId('sign-detail')
    await waitFor(() => expect(screen.getByTestId('sign-preview').getAttribute('src')).toBe('blob:view-1'))

    const title = () => detail.querySelector('h1')?.textContent
    const seen: Array<{ title: string | null | undefined; src: string | null | undefined }> = []
    const observer = new MutationObserver(() =>
      seen.push({ title: title(), src: detail.querySelector('[data-testid=sign-preview]')?.getAttribute('src') }),
    )
    observer.observe(detail, { subtree: true, childList: true, characterData: true, attributes: true })
    fireEvent.click(screen.getAllByTestId('sign-revision-row').find((row) => row.textContent?.startsWith('r2'))!)
    await waitFor(() => expect(title()).toBe('r2 of Back Shortly'))
    observer.disconnect()

    expect(seen.some((state) => state.title === 'r2 of Back Shortly')).toBe(true)
    expect(seen.filter((state) => state.title === 'r2 of Back Shortly').map(({ src }) => src ?? null)).not.toContain('blob:view-1')
    expect(screen.queryByTestId('sign-preview')).toBeNull()
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

async function openPart(current: PartRevision, approved?: PartRevision) {
  backend(current, approved)
  render(<DesignsView />)
  fireEvent.click(await screen.findByTestId('sign-revision-row'))
  return screen.findByTestId('part-detail')
}

/** Each requirement row's cells, as the person reads them. */
const requirementCells = () =>
  [...screen.getByTestId('part-requirements').querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent),
  )

describe('Part detail', () => {
  it('shows the rendered view and one row per requirement with its target and measured value', async () => {
    await openPart(part())

    const render = (await screen.findByTestId('part-render')) as HTMLImageElement
    expect(render.getAttribute('src')).toBe('blob:preview')
    expect(render.alt).toBe('Isometric view of r3')
    expect(invokeMock).toHaveBeenCalledWith('design_preview', { id: part().id })
    expect(requirementCells()).toEqual([
      ['Width span x', '22.00 ± 0.20', '22.00', 'Pass'],
      ['Desk opening opening z', '18.00 ± 0.30', '18.10', 'Pass'],
      ['Clamp wall min wall', 'at least 3.00', '3.60', 'Pass'],
    ])
  })

  it('names the part, not Signs, in the title and breadcrumb', async () => {
    await openPart(part())

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Designs/Desk-edge cable clip')
    expect(screen.getByTestId('part-detail').textContent).not.toContain('Signs')
  })

  it('lists the print warnings above Approve, and Approve sends exactly those warnings', async () => {
    const warned = part({
      build: { status: 'verified', artifacts: { ...artifacts(partChecks([W_OVERHANG, W_SUPPORT])), package_path: '/data/rev/part.3mf' } },
    })
    await openPart(warned, part({ approval: { ...APPROVED, acknowledged_warnings: [W_OVERHANG.id, W_SUPPORT.id] } }))

    const warnings = screen.getByTestId('part-warnings')
    const shown = [...warnings.querySelectorAll('li')]
    expect(shown.map((item) => item.textContent)).toEqual([W_OVERHANG.detail, W_SUPPORT.detail])
    const approve = screen.getByTestId('btn-approve')
    expect(warnings.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(approve.textContent).toBe('Approve r3 with 2 warnings for abc123f…c4e7')

    fireEvent.click(approve)

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('design_approve', {
        id: warned.id,
        packageSha256: PACKAGE_SHA,
        acknowledgedWarnings: shown.map((item) => item.getAttribute('data-check')),
      }),
    )
  })

  it('shows a failed build with its reason and no Approve', async () => {
    const opening: RecordedCheck = { id: 'geometry.requirement.1', passed: false, advisory: false, detail: 'Desk opening 17.40 mm (18 ± 0.3)' }
    await openPart(part({ build: { status: 'failed', reason: 'checks failed', artifacts: artifacts(partChecks([opening])) } }))

    expect(screen.queryByTestId('btn-approve')).toBeNull()
    expect(text('part-blocked')).toBe('r3 did not verify: Desk opening 17.40 mm (18 ± 0.3).')
    expect(requirementCells()[1]).toEqual(['Desk opening opening z', '18.00 ± 0.30', '17.40', 'Fail'])
    expect(screen.getByTestId('part-detail').textContent).not.toMatch(/Awaiting your approval/)
  })

  it('shows a build that failed before any checks with its reason and no Approve', async () => {
    const reason = 'generate: line 10: ValueError: Failed creating a fillet with radius of 99, try a smaller value'
    await openPart(part({ build: { status: 'failed', reason, artifacts: null } }))

    expect(screen.queryByTestId('btn-approve')).toBeNull()
    expect(text('part-blocked')).toBe(`r3 did not verify: ${reason}.`)
    expect(screen.queryByTestId('part-render')).toBeNull()
  })

  it('says a building part is still building, not that it made no model', async () => {
    await openPart(part({ build: { status: 'building' } }))

    expect(text('part-render-empty')).toBe('r3 is still building. Its view appears when the build ends.')
    expect(text('part-blocked')).toBe('r3 is still building.')
    expect(screen.queryByTestId('btn-approve')).toBeNull()
  })

  it('never shows the previous revision\'s image beside the next revision while its view loads', async () => {
    const r1 = part({ id: '44444444-4444-4444-8444-444444444444', number: 1 })
    const r2 = part({ id: '55555555-5555-4555-8555-555555555555', number: 2 })
    let blobs = 0
    URL.createObjectURL = vi.fn(() => `blob:view-${++blobs}`)
    invokeMock.mockImplementation(async (command: string, args?: { id?: string }) => {
      switch (command) {
        case 'design_list':
          return [r1]
        case 'design_lineage':
          return [r2, r1]
        case 'design_get':
          return args?.id === r2.id ? r2 : r1
        case 'design_preview':
          // r2's view never arrives, so whatever shows beside r2 came from r1.
          return args?.id === r1.id ? new ArrayBuffer(8) : new Promise(() => {})
        default:
          throw new Error(`unexpected command ${command}`)
      }
    })
    render(<DesignsView />)
    fireEvent.click(await screen.findByTestId('sign-revision-row'))
    const detail = await screen.findByTestId('part-detail')
    await waitFor(() => expect(screen.getByTestId('part-render').getAttribute('src')).toBe('blob:view-1'))

    // Every committed DOM state, as a person would see it, until r2 shows.
    const seen: Array<{ title: string | null | undefined; src: string | null | undefined }> = []
    const observer = new MutationObserver(() =>
      seen.push({
        title: detail.querySelector('h2')?.textContent,
        src: detail.querySelector('[data-testid=part-render]')?.getAttribute('src'),
      }),
    )
    observer.observe(detail, { subtree: true, childList: true, characterData: true, attributes: true })
    fireEvent.click(screen.getByRole('button', { name: /^r2/ }))
    await waitFor(() => expect(detail.querySelector('h2')?.textContent).toBe('r2 of Desk-edge cable clip'))
    observer.disconnect()

    expect(seen.some(({ title }) => title === 'r2 of Desk-edge cable clip')).toBe(true)
    expect(seen.filter(({ title }) => title === 'r2 of Desk-edge cable clip').map(({ src }) => src ?? null)).not.toContain('blob:view-1')
    expect(screen.queryByTestId('part-render')).toBeNull()
  })

  it('exports the approved package through the Save dialog', async () => {
    vi.mocked(save).mockResolvedValue('/Users/me/Desktop/Desk-edge cable clip-r3.3mf')
    const approved = part({ approval: APPROVED })
    await openPart(approved)

    expect(screen.queryByTestId('btn-approve')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-export'))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('design_export', {
        id: approved.id,
        format: 'print_package',
        destination: '/Users/me/Desktop/Desk-edge cable clip-r3.3mf',
      }),
    )
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'Desk-edge cable clip-r3.3mf' }))
    expect(await screen.findByTestId('export-path')).toBeTruthy()
  })
})
