import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSidecar } from './sidecar'

test('a project folder holds the guide template, with Inter and three.js in it and only the data left to fill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-guide-'))
  const projects = join(dir, 'projects')
  const app = spawnSidecar(join(dir, 'state'), projects)
  await app.next()
  const { project } = await app.sendDraft('new', 'A cable clip')
  const page = readFileSync(join(projects, project, '.m3d', 'guide-template.html'), 'utf8')
  // The page is large, so each check asks a yes or no and a failure does not print it.
  const has = (text: string) => page.includes(text)
  expect([has('const D = /*__DATA__*/null;'), has('/*__INTER__*/'), has('/*__THREE__*/')]).toEqual([true, false, false])
  // A woff2 file starts with "wOF2", which is "d09GMg" in base64.
  expect([has('src:url("data:font/woff2;base64,d09GMg'), has('window.T=')]).toEqual([true, true])
  // Every script still ends where the template ends it, so nothing three.js holds closes one early.
  expect(page.match(/<\/script/gi)).toHaveLength(3)
  await app.quit()
})
