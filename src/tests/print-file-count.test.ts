import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { folderSummary } from '../../sidecar/src/folder'
import { panelFiles } from '../studio/files'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

// The sidebar counts print files in the sidecar, and the print files bar counts them in the window. Both must skip refs/.
it('the sidebar and the print files bar count the same print files', () => {
  root = mkdtempSync(join(tmpdir(), 'm3d-prints-'))
  const rels = ['a.3mf', 'print/b.3MF', 'print/c.3mf', 'refs/theirs.3mf', 'refs/draft-2/d.3mf', 'parts.stl', 'build/refs/e.3mf']
  for (const rel of rels) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), '')
  }
  const listed = rels.map((rel) => ({ rel, size: 0, modifiedMs: 0 }))
  expect(panelFiles(listed).prints.length).toBe(folderSummary(root).printFiles)
  expect(folderSummary(root).printFiles).toBe(4)
})
