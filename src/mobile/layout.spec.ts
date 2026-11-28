import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ChatEntry, ChatView, MobileChat, ModelChoice, ModelOption } from '../../sidecar/src/protocol'
import type { Computer, DeviceDraft, LinkMessage } from './remote'

/**
 * The phone and tablet layouts at real screen sizes, in the production mobile window build. jsdom has no layout, so
 * these are the checks for #358 (the chat list did not scroll) and #368 (a role menu left the screen on a phone on its
 * side, and a reply that came on the Model tab was out of sight on the way back to Chat).
 */
const sizes = [
  { name: 'small phone', width: 375, height: 667, tablet: false },
  { name: 'phone', width: 390, height: 844, tablet: false },
  { name: 'phone on its side', width: 667, height: 340, tablet: false },
  { name: 'tablet', width: 820, height: 1180, tablet: true },
] as const

const lead: ModelChoice = { provider: 'anthropic', modelId: 'lead-model' }
/** A long catalog, so a menu is taller than a phone on its side. */
const models: ModelOption[] = Array.from({ length: 16 }, (_, i) => ({
  provider: 'anthropic',
  modelId: i === 0 ? lead.modelId : `model-${i}`,
  name: `Model ${i + 1}`,
  description: '',
}))
const chats: MobileChat[] = Array.from({ length: 40 }, (_, i) => ({
  id: `chat-${i + 1}`,
  title: `Chat ${i + 1}`,
  createdMs: 0,
  lead,
  helper: null,
  status: { running: false, printed: false, printFiles: 0, lastMs: 0 },
}))
/** A transcript taller than any of the sizes, so the newest line is out of sight unless the chat follows it. */
const entries: ChatEntry[] = Array.from({ length: 30 }, (_, i): ChatEntry[] => [
  { id: 2 * i + 1, kind: 'user', text: `Question ${i + 1}: make the bracket a little thicker where it meets the wall.`, images: [], files: [] },
  { id: 2 * i + 2, kind: 'assistant', text: `Answer ${i + 1}: the bracket is now 2 mm thicker at the wall.`, calls: [], model: lead },
]).flat()
/** A draft with a picture, which makes the composer taller and leaves a role menu less room above it. */
const draft: DeviceDraft = {
  text: '',
  pictures: [{ name: 'part.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }],
  sent: null,
}
const computer: Computer = { id: 'pairing-1', name: 'Workshop computer', origin: 'https://computer.example.ts.net' }

type Setup = { computer: Computer; chats: MobileChat[]; entries: ChatEntry[]; models: ModelOption[]; draft: DeviceDraft }

/**
 * Stands in for Rust and the paired computer: the `__TAURI_INTERNALS__` the Tauri API calls, and `fetch` for the
 * `m3dremote://` protocol. The test makes the computer reply with `window.m3dReply`. Runs in the page, so it closes over
 * nothing.
 */
function fakeDevice(setup: Setup) {
  const callbacks = new Map<number, (message: { index: number; message: LinkMessage }) => void>()
  let nextCallback = 1
  const link = { channel: 0, index: 0 }
  const tell = (message: LinkMessage) => callbacks.get(link.channel)?.({ index: link.index++, message })
  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    paired_computer: () => setup.computer,
    link_watch: (args) => {
      link.channel = (args.channel as { id: number }).id
      setTimeout(() => tell({ kind: 'connected' }))
      return null
    },
    draft_load: () => setup.draft,
    draft_save: () => null,
    stop_model_reads: () => null,
  }
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      transformCallback: (callback: (message: { index: number; message: LinkMessage }) => void) => {
        callbacks.set(nextCallback, callback)
        return nextCallback++
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        const command = commands[cmd]
        if (command === undefined) throw new Error(`The fake device has no command ${cmd}.`)
        return command(args)
      },
    },
  })

  const entries = [...setup.entries]
  let seq = 1
  const view = (project: string): ChatView => ({ project, entries, running: false, waiting: null, turn: null, handoffs: [], seq })
  const answers: [RegExp, (path: string) => unknown][] = [
    [/^\/api\/v1\/chats$/, () => setup.chats],
    [/^\/api\/v1\/models$/, () => setup.models],
    [/^\/api\/v1\/chats\/[^/]+\/files$/, () => []],
    [/^\/api\/v1\/chats\/[^/]+$/, (path) => view(decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)))],
  ]
  const pageFetch = window.fetch
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith('m3dremote://localhost')) return pageFetch(input, init)
    const path = url.slice('m3dremote://localhost'.length)
    const answer = answers.find(([route]) => route.test(path))
    if (answer === undefined || (init?.method ?? 'GET') !== 'GET') return new Response('{"error":"not faked"}', { status: 404 })
    return new Response(JSON.stringify(answer[1](path)), { headers: { 'content-type': 'application/json' } })
  }
  Object.assign(window, {
    m3dReply: (project: string, text: string) => {
      const reply: ChatEntry = { id: entries.length + 1, kind: 'assistant', text, calls: [], model: setup.entries.find((e) => e.kind === 'assistant')!.model }
      entries.push(reply)
      seq += 1
      tell({ kind: 'event', event: { type: 'chat', ...view(project), entries: [reply] } })
    },
  })
}

async function open(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size)
  await page.addInitScript(fakeDevice, { computer, chats, entries, models, draft } satisfies Setup)
  await page.goto('./')
  await expect(page.getByRole('heading', { name: computer.name })).toBeVisible()
  await expect(page.locator('.mobile-chats li')).toHaveCount(chats.length)
}

/**
 * Where `target` sits, and whether a person can touch it: its whole box inside the viewport, and its center not under
 * anything else or clipped by a scroll box around it.
 */
const onScreen = (target: Locator) =>
  target.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    const inside = box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
    return { inside, touchable: hit !== null && el.contains(hit), top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: innerHeight }
  })

const onScreenNow = { inside: true, touchable: true }

/** Taps the center of `target` where it is now. A locator's own tap scrolls it into view first, which a person cannot do. */
async function tapInPlace(page: Page, target: Locator) {
  const box = await target.boundingBox()
  if (box === null) throw new Error('The target has no box to tap.')
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

/**
 * Swipes `scroller` with one finger until `target` can be touched, as a person on a phone or tablet does. Chrome's
 * touch events scroll only a box a finger can scroll: never one the page clips, and never one with `touch-action: none`.
 * (Its synthesized scroll gesture moves nothing in headless Chrome, so the finger moves step by step.) The finger starts
 * in the middle of the part of `scroller` inside the viewport, stays on that part, and always moves farther than a tap.
 */
async function swipeToTouch(page: Page, scroller: Locator, target: Locator) {
  const chrome = await page.context().newCDPSession(page)
  for (let i = 0; i < 30 && !(await onScreen(target)).touchable; i += 1) {
    const { x, y, delta, reach } = await target.evaluate((el, box) => {
      const shown = box!.getBoundingClientRect()
      const top = Math.max(shown.top, 0)
      const bottom = Math.min(shown.bottom, innerHeight)
      return { x: shown.left + shown.width / 2, y: (top + bottom) / 2, delta: el.getBoundingClientRect().top - top, reach: (bottom - top) / 2 - 4 }
    }, await scroller.elementHandle())
    // The finger moves up to bring later content into view, so it travels the opposite way to the target.
    const travel = -Math.sign(delta) * Math.min(reach, Math.max(Math.abs(delta), 40))
    await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 8; step += 1) {
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (travel * step) / 8 }] })
    }
    await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    // The scroll lands after the touch ends, so wait two frames.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  }
  await chrome.detach()
}

/** Opens the first chat from the list and waits until its composer can pick roles. */
async function openChat(page: Page) {
  await tapInPlace(page, page.getByRole('button', { name: chats[0].title, exact: true }))
  await expect(page.getByRole('heading', { name: chats[0].title })).toBeVisible()
  await expect(page.getByText('Connected')).toBeVisible()
  await expect(page.getByTestId('model-picker')).toBeEnabled()
}

for (const size of sizes) {
  test.describe(`${size.name} ${size.width}x${size.height}`, () => {
    test('the last chat in a long list scrolls into view and opens', async ({ page }) => {
      await open(page, size)
      const last = page.getByRole('button', { name: chats[chats.length - 1].title, exact: true })
      await swipeToTouch(page, page.locator('.mobile-chats'), last)
      expect(await onScreen(last)).toMatchObject(onScreenNow)
      await tapInPlace(page, last)
      await expect(page.getByRole('heading', { name: chats[chats.length - 1].title })).toBeVisible()
    })

    test('every option of each open role menu sits on screen', async ({ page }) => {
      await open(page, size)
      await openChat(page)
      for (const role of ['Lead', 'Helper'] as const) {
        const picker = page.getByTestId(role === 'Lead' ? 'model-picker' : 'helper-picker')
        expect(await onScreen(picker), `the ${role} picker`).toMatchObject(onScreenNow)
        await tapInPlace(page, picker)
        const menu = page.getByRole('menu', { name: `${role} models` })
        await expect(menu).toBeVisible()
        const options = menu.getByRole('menuitemradio')
        await expect(options).toHaveCount(models.length + (role === 'Helper' ? 1 : 0))
        for (const option of await options.all()) {
          await swipeToTouch(page, menu, option)
          expect(await onScreen(option), `${role}: ${await option.textContent()}`).toMatchObject(onScreenNow)
        }
        await page.keyboard.press('Escape')
        await expect(menu).toBeHidden()
      }
    })

    test('the newest line is in view after Chat, Model, Chat', async ({ page }) => {
      await open(page, size)
      await openChat(page)
      const newest = () => page.getByTestId('messages').locator('.msg-agent').last()
      await expect(newest()).toHaveText(`Answer ${entries.length / 2}: the bracket is now 2 mm thicker at the wall.`)
      await expect.poll(() => onScreen(newest())).toMatchObject(onScreenNow)
      const reply = 'The thicker bracket is ready to slice.'
      const chatPane = page.locator('.mobile-chat-pane')
      // A tablet shows the chat and the model together, with no tabs, so the reply arrives with the chat in sight. A
      // phone has the tabs, and the reply arrives while the Model tab hides the chat.
      if (size.tablet) {
        await expect(page.getByRole('tablist')).toBeHidden()
      } else {
        await page.getByRole('tab', { name: 'Model' }).tap()
        await expect(chatPane).toBeHidden()
      }
      await page.evaluate(([project, text]) => (window as unknown as { m3dReply: (p: string, t: string) => void }).m3dReply(project, text), [chats[0].id, reply])
      if (!size.tablet) await page.getByRole('tab', { name: 'Chat' }).tap()
      await expect(chatPane).toBeVisible()
      await expect(newest()).toHaveText(reply)
      await expect.poll(() => onScreen(newest())).toMatchObject(onScreenNow)
    })
  })
}
