import { describe, expect, it } from 'vitest'
import type { Project, ProjectStatus } from '../../sidecar/src/protocol'
import { ago, detail, groupOf, groupProjects, printerName } from './sidebarGroups'

const status = (more: Partial<ProjectStatus> = {}): ProjectStatus => ({ running: false, printed: false, printFiles: 0, lastMs: 0, ...more })
const project = (id: string, createdMs = 0): Project => ({ id, conversation: 1, title: id, createdMs })

describe('sidebar groups', () => {
  it('puts a project with a running turn in Working, even with print files or a printed mark', () => {
    expect(groupOf(status({ running: true, printFiles: 2, printed: true }))).toBe('working')
  })

  it('puts an idle project with at least one print file in Ready to print', () => {
    expect(groupOf(status({ printFiles: 1 }))).toBe('ready')
  })

  it('puts a project the person marked printed in Printed, though it has print files', () => {
    expect(groupOf(status({ printed: true, printFiles: 3 }))).toBe('printed')
  })

  it('puts everything else in Drafts, a project whose status has not come yet included', () => {
    expect(groupOf(status())).toBe('drafts')
    expect(groupOf(undefined)).toBe('drafts')
  })

  it('shows only groups that hold projects, in order, each newest first', () => {
    const projects = [project('old-draft', 1), project('ready'), project('new-draft', 5)]
    const groups = groupProjects(projects, { ready: status({ printFiles: 1, lastMs: 9 }), 'old-draft': status({ lastMs: 1 }) })
    expect(groups.map(({ group, projects }) => [group, projects.map((p) => p.id)])).toEqual([
      ['ready', ['ready']],
      ['drafts', ['new-draft', 'old-draft']],
    ])
  })

  it('says what a row holds on its second line', () => {
    expect(detail('working', status())).toBe('Building parts')
    expect(detail('ready', status({ printFiles: 1 }))).toBe('1 print file')
    expect(detail('ready', status({ printFiles: 2 }))).toBe('2 print files')
    expect(detail('drafts', status())).toBeUndefined()
  })
})

describe('last activity', () => {
  const now = new Date(2026, 10, 9, 15, 0).getTime()
  const before = (ms: number) => ago(now - ms, now)

  it('reads as minutes, hours, and days, then a short date', () => {
    expect(before(30_000)).toBe('now')
    expect(before(2 * 60_000)).toBe('2m')
    expect(before(60 * 60_000)).toBe('1h')
    expect(before(3 * 24 * 60 * 60_000)).toBe('3d')
    expect(ago(new Date(2026, 9, 30, 12, 0).getTime(), now)).toBe('Oct 30')
    expect(ago(new Date(2025, 9, 30, 12, 0).getTime(), now)).toBe('Oct 30, 2025')
  })
})

describe('printer name', () => {
  it('names a printer by its model, without the maker or the nozzle', () => {
    expect(printerName('Bambu Lab P2S 0.4 nozzle')).toBe('P2S')
    expect(printerName('Bambu Lab A1 mini 0.2 nozzle')).toBe('A1 mini')
    expect(printerName('My P2S for PETG')).toBe('My P2S for PETG')
  })
})
