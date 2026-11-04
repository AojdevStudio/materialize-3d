// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesDir = new URL('../styles/', import.meta.url)
const css = readdirSync(stylesDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(new URL(name, stylesDir), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

// Issue #131 tracks these. Remove each one here when it gets defined.
const KNOWN_UNDEFINED = ['--bg-card', '--sp-1', '--sp-2', '--sp-3', '--sp-4']

describe('design tokens', () => {
  it('every var() without a fallback in src/styles names a defined token', () => {
    const defined = new Set(Array.from(css.matchAll(/(--[\w-]+)\s*:/g), ([, name]) => name))
    const used = new Set(Array.from(css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g), ([, name]) => name))
    const undefinedTokens = [...used].filter((name) => !defined.has(name)).sort()
    expect(undefinedTokens).toEqual(KNOWN_UNDEFINED)
  })
})
