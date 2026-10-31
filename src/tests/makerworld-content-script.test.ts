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
const DESIGN_PATH = '/api/v1/design-service/design/2133969'

type Report = { pageKind: string; detectedModel: Record<string, unknown> | null }
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

const respond = (design: unknown, status = 200): FakeResponse => ({ ok: status === 200, status, json: async () => design })
const notFound = () => respond(null, 404)

const doms: JSDOM[] = []

afterEach(() => {
  doms.splice(0).forEach((dom) => dom.window.close())
})

function runContentScript(url: string, body: string, fetchDesign: (path: string) => FakeResponse | Promise<FakeResponse> = notFound) {
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
      return fetchDesign(path)
    },
  })
  dom.window.eval(contentScript)
  const waitForReport = async (matches: (report: Report) => boolean = () => true) => {
    await vi.waitFor(() => expect(reports.some(matches)).toBe(true), { timeout: 2000 })
    return reports.filter(matches).at(-1)!
  }
  return { dom, reports, fetchCalls, waitForReport }
}

const nextDataScript = (json: string) => `<script id="__NEXT_DATA__" type="application/json">${json}</script>`
const searchNextData = nextDataScript(
  JSON.stringify({ page: '/search/models', props: { pageProps: { designs: [{ id: 1, score: 1 }] } } }),
)
const hasRating = (report: Report) => report.detectedModel?.rating != null

describe('MakerWorld content script', () => {
  it('reads the selected print profile rating and the model counts from the real page data', async () => {
    const { fetchCalls, waitForReport } = runContentScript(`${MODEL_URL}#profileId-2311143`, nextDataScript(nextDataFixture))
    const report = await waitForReport()

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
    const { fetchCalls, waitForReport } = runContentScript(`${MODEL_URL}?from=search#profileId-2311143`, searchNextData, (path) =>
      path === DESIGN_PATH ? respond(designFixture) : notFound(),
    )
    const report = await waitForReport(hasRating)

    expect(fetchCalls).toEqual([DESIGN_PATH])
    expect(report.detectedModel).toMatchObject({ id: '2133969', rating: 4.9, reviewCount: 585, downloadCount: 7863 })
    expect(report.detectedModel!.files).toHaveLength(9)
  })

  it('reports this model with no numbers while its design request is still pending', async () => {
    const { reports, waitForReport } = runContentScript(
      `${MODEL_URL}#profileId-2311143`,
      `<h1>Onion &amp; Potato Dispenser</h1>${searchNextData}`,
      () => new Promise<FakeResponse>(() => {}),
    )
    const report = await waitForReport()

    expect(report.detectedModel).toMatchObject({ id: '2133969', rating: null, reviewCount: null, downloadCount: null })
    expect(reports.some(hasRating)).toBe(false)
  })

  it('retries a failed design request on the next page scan', async () => {
    let attempts = 0
    const { dom, fetchCalls, waitForReport } = runContentScript(`${MODEL_URL}#profileId-2311143`, searchNextData, () =>
      ++attempts === 1 ? respond(null, 503) : respond(designFixture),
    )
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1))
    await waitForReport()

    ;(dom.window as unknown as { __MATERIALIZE_SCAN__: (reason: string) => void }).__MATERIALIZE_SCAN__('page-load')
    const report = await waitForReport(hasRating)

    expect(fetchCalls).toEqual([DESIGN_PATH, DESIGN_PATH])
    expect(report.detectedModel).toMatchObject({ rating: 4.9, reviewCount: 585, downloadCount: 7863 })
  })

  it('shows no rating when the page names no print profile', async () => {
    const { waitForReport } = runContentScript(MODEL_URL, nextDataScript(nextDataFixture))
    const report = await waitForReport()

    expect(report.detectedModel).toMatchObject({ rating: null, reviewCount: 585, downloadCount: 7863 })
  })

  it('shows no numbers when the page has no design data, even if the markup holds rating-like text', async () => {
    const { waitForReport } = runContentScript(
      `${MODEL_URL}#profileId-2311143`,
      '<h1>Onion &amp; Potato Dispenser</h1><div class="rating">1.0</div><span class="review-count">233</span>',
    )
    const report = await waitForReport()

    expect(report.detectedModel).toMatchObject({
      title: 'Onion & Potato Dispenser',
      rating: null,
      reviewCount: null,
      downloadCount: null,
    })
  })
})
