import { describe, expect, it } from 'vitest'
import workflow from '../../sidecar/src/workflow.md?raw'
import { fileKind, fileName, firstView, formatSize, is3mf, PAGE_VIEWS, panelFiles, viewOf } from './files'
import type { ProjectFile } from './native-types'

const file = (rel: string, modifiedMs: number): ProjectFile => ({ rel, size: 1, modifiedMs })
const rels = (files: (ProjectFile | undefined)[]) => files.map((f) => f?.rel)

describe('the file rules the panel and the file list share', () => {
  it.each([
    ['guide.html', 'html'],
    ['Guide.HTM', 'html'],
    ['part.STL', 'model'],
    ['print/plate.3mf', 'model'],
    ['arm.glb', 'model'],
    ['arm.gltf', 'model'],
    ['photo.JPEG', 'image'],
    ['logo.svg', 'image'],
    ['notes.md', 'text'],
    ['bracket.scad', 'text'],
    ['run.py', 'text'],
    ['archive.zip', 'other'],
    ['Makefile', 'other'],
    ['.env', 'other'],
    ['model.tar.gz', 'other'],
  ])('fileKind(%s) is %s', (rel, kind) => {
    expect(fileKind(rel)).toBe(kind)
  })

  it.each([
    ['print/A.3MF', true],
    ['plate.3mf', true],
    ['plate.3mf.bak', false],
    ['plate.stl', false],
  ])('is3mf(%s) is %s', (rel, yes) => {
    expect(is3mf(rel)).toBe(yes)
  })

  it.each([
    ['guide.html', 'guide'],
    ['Guide-Adapter.HTML', 'guide'],
    ['guidebook.html', 'guide'],
    ['drawing-b.htm', 'drawing'],
    ['build/guide.html', 'files'],
    ['refs/drawing.html', 'files'],
    ['overview.html', 'files'],
    ['parts.stl', 'model'],
    ['print/plate.3mf', 'model'],
    ['refs/photo.png', 'files'],
    ['notes.md', 'files'],
  ])('viewOf(%s) is %s', (rel, view) => {
    expect(viewOf(rel)).toBe(view)
  })

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '2 KB'],
    [1024 * 1024 - 1, '1024 KB'],
    [1024 * 1024, '1.0 MB'],
    [1.5 * 1024 * 1024, '1.5 MB'],
  ])('formatSize(%d) is %s', (bytes, shown) => {
    expect(formatSize(bytes)).toBe(shown)
  })
})

describe('panelFiles and firstView', () => {
  const project = [
    file('guide.html', 1),
    file('guide-b.html', 5),
    file('build/guide.html', 9),
    file('refs/guide-z.html', 10),
    file('drawing.html', 3),
    file('parts.stl', 4),
    file('parts.glb', 4),
    file('print/a.3mf', 6),
    file('print/b.3mf', 7),
    file('refs/theirs.3mf', 11),
    file('notes.md', 8),
  ]

  it('picks the newest of each view outside refs/, print files newest first, and the newest shown file as latest', () => {
    const shown = panelFiles(project)
    expect(rels([shown.guide, shown.model, shown.drawing, shown.latest])).toEqual(['guide-b.html', 'parts.stl', 'drawing.html', 'guide-b.html'])
    expect(rels(shown.prints)).toEqual(['print/b.3mf', 'print/a.3mf'])
    expect(firstView(shown)).toBe('guide')
  })

  it('keeps the list order between models whose modified times tie', () => {
    const swapped = project.map((f) => (f.rel === 'parts.stl' ? file('parts.glb', 4) : f.rel === 'parts.glb' ? file('parts.stl', 4) : f))
    expect(panelFiles(swapped).model?.rel).toBe('parts.glb')
  })

  it('shows the newest 3MF as the model only when no other model exists, and never as latest', () => {
    const shown = panelFiles(project.filter((f) => !['parts.stl', 'parts.glb'].includes(f.rel)))
    expect(shown.model?.rel).toBe('print/b.3mf')
    expect(shown.latest?.rel).toBe('guide-b.html')
  })

  it('opens on the first view with something to show', () => {
    const noGuide = panelFiles(project.filter((f) => !f.rel.startsWith('guide')))
    expect(firstView(noGuide)).toBe('model')
    const drawingOnly = panelFiles([file('drawing.html', 1), file('notes.md', 2)])
    expect(firstView(drawingOnly)).toBe('drawing')
    expect(drawingOnly.latest?.rel).toBe('drawing.html')
  })

  it('takes nothing from refs/, so a project of the person\'s own files shows Files', () => {
    const shown = panelFiles([file('refs/theirs.3mf', 1), file('refs/guide.html', 2), file('refs/part.stl', 3)])
    expect(shown).toEqual({ guide: undefined, model: undefined, drawing: undefined, prints: [], latest: undefined })
    expect(firstView(shown)).toBe('files')
    expect(firstView(panelFiles([]))).toBe('files')
  })
})

describe('the names the window and the agent share', () => {
  it('the agent prompt names each page the panel looks for', () => {
    for (const view of PAGE_VIEWS) expect(workflow).toContain(`\`${view}*.html\``)
  })

  it.each([
    ['print/plate.3mf', 'plate.3mf'],
    ['plate.3mf', 'plate.3mf'],
    ['/Users/me/Desktop/photo 1.png', 'photo 1.png'],
  ])('fileName(%s) is %s', (path, name) => {
    expect(fileName(path)).toBe(name)
  })
})
