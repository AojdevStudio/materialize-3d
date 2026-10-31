// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const contentScript = readFileSync(new URL('../../src-tauri/src/makerworld_content_script.js', import.meta.url), 'utf8')
const nextDataFixture = readFileSync(
  new URL('../../src-tauri/tests/fixtures/makerworld/2133969-next-data.json', import.meta.url),
  'utf8',
)
const designFixture = JSON.parse(nextDataFixture).props.pageProps.design

const MODEL_URL = 'https://makerworld.com/en/models/2133969-onion-potato-dispenser-with-garlic-add-on'

type Report = { pageKind: string; detectedModel: Record<string, unknown> | null }

const doms: JSDOM[] = []

afterEach(() => {
  doms.splice(0).forEach((dom) => dom.window.close())
})

async function runContentScript(url: string, body: string, fetchDesign: (path: string) => unknown = () => null) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    url,
    runScripts: 'outside-only',
  })
  doms.push(dom)
  const reports: Report[] = []
  const fetchCalls: string[] = []
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: { payload: Report }) => {
        if (cmd === 'report_makerworld_page') reports.push(args.payload)
        return null
      },
    },
    fetch: async (path: string) => {
      fetchCalls.push(path)
      const design = fetchDesign(path)
      return { ok: design != null, status: design != null ? 200 : 404, json: async () => design }
    },
  })
  dom.window.eval(contentScript)
  await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0), { timeout: 2000 })
  return { report: reports.at(-1)!, fetchCalls }
}

const nextDataScript = (json: string) => `<script id="__NEXT_DATA__" type="application/json">${json}</script>`

describe('MakerWorld content script', () => {
  it('reads the selected print profile rating and the model counts from the real page data', async () => {
    const { report, fetchCalls } = await runContentScript(`${MODEL_URL}#profileId-2311143`, nextDataScript(nextDataFixture))

    expect(fetchCalls).toEqual([])
    expect(report.pageKind).toBe('model')
    expect(report.detectedModel).toMatchObject({
      id: '2133969',
      title: 'Onion & Potato Dispenser with Garlic Add-on',
      rating: 4.9,
      reviewCount: 585,
      downloadCount: 7863,
    })
    const files = report.detectedModel!.files as Array<{ name: string; fileType: string | null }>
    expect(files).toHaveLength(9)
    expect(files[0]).toEqual({ name: 'Onion & Potato Dispenser – Original Size', fileType: '3mf', downloadUrl: null })
  })

  it('fetches the design when a client-side route change left the search page data behind', async () => {
    const searchNextData = JSON.stringify({ page: '/search/models', props: { pageProps: { designs: [{ id: 1, score: 1 }] } } })
    const { report, fetchCalls } = await runContentScript(
      `${MODEL_URL}?from=search#profileId-2311143`,
      nextDataScript(searchNextData),
      (path) => (path === '/api/v1/design-service/design/2133969' ? designFixture : null),
    )

    expect(fetchCalls).toEqual(['/api/v1/design-service/design/2133969'])
    expect(report.detectedModel).toMatchObject({ id: '2133969', rating: 4.9, reviewCount: 585, downloadCount: 7863 })
    expect(report.detectedModel!.files).toHaveLength(9)
  })

  it('shows no rating when the page names no print profile', async () => {
    const { report } = await runContentScript(MODEL_URL, nextDataScript(nextDataFixture))

    expect(report.detectedModel).toMatchObject({ rating: null, reviewCount: 585, downloadCount: 7863 })
  })

  it('shows no numbers when the page has no design data, even if the markup holds rating-like text', async () => {
    const { report } = await runContentScript(
      `${MODEL_URL}#profileId-2311143`,
      '<h1>Onion &amp; Potato Dispenser</h1><div class="rating">1.0</div><span class="review-count">233</span>',
    )

    expect(report.detectedModel).toMatchObject({
      title: 'Onion & Potato Dispenser',
      rating: null,
      reviewCount: null,
      downloadCount: null,
    })
  })
})
