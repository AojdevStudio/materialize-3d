import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { appleTrusted, checksumPublished, externalLinks, release } from "../src/release";
import { STAGES, at, type StageId } from "../src/story/timeline";

type Theme = "light" | "dark";

const shotsDir = path.resolve(import.meta.dirname, "../test-results/screens");

/** Start the page in a given theme the way a returning visitor would: via the remembered choice. */
async function open(page: Page, theme: Theme = "light") {
  if (theme === "dark") await page.addInitScript(() => localStorage.setItem("m3d-theme", "dark"));
  await page.goto("./");
}

/** Waits for the 3D view to load, so the labels and the scene are live. */
async function storyReady(page: Page) {
  await expect(page.locator(".story-status"), "the 3D view loaded").toHaveText("", { timeout: 30_000 });
}

/** Scrolls the story to a position in vh and waits until it stops writing to the view, so eased motion has settled. */
async function scrollStory(page: Page, vh: number) {
  await page.evaluate((top) => window.scrollTo({ top: (top * innerHeight) / 100, behavior: "instant" }), vh);
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const view = document.querySelector(".story-view") ?? document.body;
        let last = performance.now();
        const observer = new MutationObserver(() => (last = performance.now()));
        observer.observe(view, { subtree: true, attributes: true, characterData: true, childList: true });
        const check = () => {
          if (performance.now() - last < 800) return void setTimeout(check, 100);
          observer.disconnect();
          done();
        };
        setTimeout(check, 100);
      }),
  );
}

const readout = (page: Page) =>
  page.locator(".readout").evaluate((box) => ({
    kick: box.querySelector('[data-readout="kick"]')?.textContent,
    value: box.querySelector(".readout-value")?.textContent,
    line: box.querySelector('[data-readout="line"]')?.textContent,
  }));

const layouts = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
  { name: "small", width: 320, height: 640 },
] as const;

for (const layout of layouts) {
  for (const theme of ["light", "dark"] as const) {
    test(`${layout.name} ${layout.width} ${theme}: renders without horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await open(page, theme);
      await storyReady(page);
      const overflow = () =>
        page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      const top = await overflow();
      expect(top.scrollWidth).toBeLessThanOrEqual(top.clientWidth);
      await page.screenshot({ path: path.join(shotsDir, `${layout.name}-${layout.width}-${theme}-top.png`) });

      await page.locator("#download").scrollIntoViewIfNeeded();
      const end = await overflow();
      expect(end.scrollWidth).toBeLessThanOrEqual(end.clientWidth);
      await page.screenshot({ path: path.join(shotsDir, `${layout.name}-${layout.width}-${theme}-end.png`) });
    });
  }
}

test("download is the first prominent action and points at the configured DMG", async ({ page }) => {
  await open(page);
  const first = page.locator("main a[href]").first();
  await expect(first).toHaveText(`Download for Mac (${release.architecture})`);
  await expect(first).toHaveAttribute("href", release.dmgUrl);

  const box = await first.boundingBox();
  if (!box) throw new Error("download link has no layout box");
  expect(box.y + box.height, "download sits in the first desktop viewport").toBeLessThanOrEqual(900);
});

test("every in-page anchor and internal link resolves", async ({ page, request }) => {
  await open(page);
  const links = await page
    .locator("a[href]")
    .evaluateAll((as) => as.map((a) => ({ raw: a.getAttribute("href") ?? "", abs: (a as HTMLAnchorElement).href })));
  const origin = new URL(page.url()).origin;
  const internal = links.filter((l) => new URL(l.abs).origin === origin);
  expect(internal.length).toBeGreaterThan(0);

  for (const link of internal) {
    if (link.raw.startsWith("#")) {
      await expect(page.locator(`[id="${link.raw.slice(1)}"]`), link.raw).toHaveCount(1);
    } else {
      expect(new URL(link.abs).pathname, link.raw).toMatch(/^\/materialize-3d\//);
      expect((await request.get(link.abs)).status(), link.raw).toBe(200);
    }
  }
});

test("external links are exactly the configured ones", async ({ page }) => {
  await open(page);
  const origin = new URL(page.url()).origin;
  const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  const external = new Set(hrefs.filter((h) => new URL(h).origin !== origin));
  expect([...external].sort()).toEqual([...new Set(externalLinks)].sort());
});

test("keyboard reaches every link and the theme toggle with a visible focus ring", async ({ page }) => {
  await open(page);
  const total = await page.locator("a[href], button").evaluateAll((els) => {
    els.forEach((el, i) => el.setAttribute("data-kb", String(i)));
    return els.length;
  });

  const reached = new Set<string>();
  for (let i = 0; i < total + 5 && reached.size < total; i++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        id: el.dataset.kb ?? `untracked:${el.outerHTML.slice(0, 60)}`,
        label: el.textContent?.trim() ?? "",
        outlineStyle: s.outlineStyle,
        outlineWidth: Number.parseFloat(s.outlineWidth),
      };
    });
    if (!focus) continue;
    expect(focus.outlineStyle, `focus ring on "${focus.label}"`).not.toBe("none");
    expect(focus.outlineWidth, `focus ring width on "${focus.label}"`).toBeGreaterThanOrEqual(2);
    reached.add(focus.id);
  }

  expect(reached.size).toBe(total);
  await expect(page.locator("button[aria-pressed][data-kb]")).toHaveCount(1);
});

for (const theme of ["light", "dark"] as const) {
  test(`axe reports no violations in ${theme} theme, on the still story`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    if (theme === "dark") {
      // Use the toggle, then reload: dark must be remembered and be pure black with white text.
      await page.getByRole("button", { name: "Dark mode" }).click();
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.getByRole("button", { name: "Dark mode" })).toHaveAttribute("aria-pressed", "true");
      const colors = await page.evaluate(() => {
        const s = getComputedStyle(document.body);
        return { bg: s.backgroundColor, fg: s.color };
      });
      expect(colors).toEqual({ bg: "rgb(0, 0, 0)", fg: "rgb(255, 255, 255)" });
    }
    await storyReady(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  });
}

test("how it works tells the chat studio story in order, and the page says no release has it yet", async ({ page }) => {
  await open(page);
  await expect(page.locator("#how h3")).toHaveText(["Describe", "Make", "Look", "Print"]);
  const text = await page.locator("body").innerText();
  expect(text).toContain("The chat studio is not in a release yet.");
  expect(text).toContain(`This download is ${release.version}, the earlier sign app.`);
  expect(text).not.toMatch(/\bMCP\b/);
});

/** The trace card at each rewind still: its kick, its head, and the newest of the lines still in, oldest first. */
const TRACE_STILLS: Partial<Record<StageId, { kick: string; head: string; count: string; lines: number; newest: string }>> = {
  slices: { kick: "How it got here · 13:58", head: "Worked for 14 min", count: "6 steps", lines: 6, newest: "Sliced 2 print files" },
  guide: { kick: "Rewind · 9:47", head: "Working for 9:47", count: "step 5 of 6", lines: 5, newest: "Wrote assembly-guide.html" },
  adapter: { kick: "Rewind · 6:05", head: "Working for 6:05", count: "step 4 of 6", lines: 4, newest: "Added the revision C arm adapter" },
  parts: { kick: "Rewind · 0:39", head: "Working for 0:39", count: "step 3 of 6", lines: 3, newest: "Built 5 printed parts" },
  drawing: { kick: "Rewind · 0:26", head: "Working for 0:26", count: "step 2 of 6", lines: 2, newest: "Astra drew drawing.html" },
  params: { kick: "Rewind · 0:12", head: "Working for 0:12", count: "step 1 of 6", lines: 1, newest: "Wrote params.json" },
};

for (const layout of layouts.slice(0, 2)) {
  test(`${layout.name} ${layout.width}: with reduced motion each stage is one still, in story order`, async ({ page }) => {
    test.slow(); // 22 screenshots, and the 3D view may draw in software
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await storyReady(page);
    const shownCopy = () =>
      page.locator(".stage-copy").evaluateAll((blocks) => blocks.filter((b) => getComputedStyle(b).opacity === "1").map((b) => b.getAttribute("data-stage")));
    const trace = () =>
      page.locator(".story-trace").evaluate((box) => {
        const lines = [...box.querySelectorAll(".trace-lines li")].filter((li) => Number(getComputedStyle(li).opacity) > 0.5 && li.getBoundingClientRect().height > 1);
        return {
          shown: getComputedStyle(box).opacity === "1",
          kick: box.querySelector('[data-trace="kick"]')?.textContent,
          head: box.querySelector('[data-trace="head"]')?.textContent,
          count: box.querySelector('[data-trace="count"]')?.textContent,
          lines: lines.length,
          newest: lines.at(-1)?.querySelector(".trace-did")?.textContent,
        };
      });

    for (const [i, stage] of STAGES.entries()) {
      await scrollStory(page, i * 100 + 30);
      const still = TRACE_STILLS[stage.id];
      expect(await shownCopy(), `stage ${i + 1} shows only its own copy`).toEqual(still ? [] : [stage.id]);
      if (still) expect(await trace(), `stage ${i + 1} shows the trace card, its lines leaving from the bottom`).toEqual({ shown: true, ...still });
      else expect((await trace()).shown, `stage ${i + 1} hides the trace card`).toBe(false);
      const early = await page.screenshot();
      await scrollStory(page, i * 100 + 70);
      expect(early.equals(await page.screenshot()), `nothing moves while scrolling through ${stage.id}`).toBe(true);
    }
  });
}

for (const layout of layouts.slice(0, 2)) {
  test(`${layout.name} ${layout.width}: the trace card covers no part of the 3D view in any rewind still`, async ({ page }) => {
    test.slow(); // six stills, and the 3D view may draw in software
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await storyReady(page);
    // The canvas clears to transparent, so under the card every pixel that is not the page's paper is the model.
    const paper = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    for (const [i, stage] of STAGES.entries()) {
      if (!TRACE_STILLS[stage.id]) continue;
      await scrollStory(page, i * 100 + 30);
      const box = await page.locator(".trace-card").boundingBox();
      if (!box) throw new Error("the trace card has no layout box");
      await page.locator(".story-trace").evaluate((trace: HTMLElement) => (trace.style.visibility = "hidden"));
      const under = await page.screenshot({ clip: box });
      await page.locator(".story-trace").evaluate((trace: HTMLElement) => (trace.style.visibility = ""));
      const model = await page.evaluate(
        async ({ png, paper }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const canvas = new OffscreenCanvas(image.width, image.height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("no 2D context");
          context.drawImage(image, 0, 0);
          const { data } = context.getImageData(0, 0, image.width, image.height);
          const [r = 0, g = 0, b = 0] = (paper.match(/\d+/g) ?? []).map(Number);
          let count = 0;
          for (let p = 0; p < data.length; p += 4) {
            const [pr = 0, pg = 0, pb = 0] = data.subarray(p, p + 3);
            if (Math.max(Math.abs(pr - r), Math.abs(pg - g), Math.abs(pb - b)) > 10) count++;
          }
          return count;
        },
        { png: under.toString("base64"), paper },
      );
      expect(model, `${stage.id}: pixels of the 3D view under the trace card`).toBe(0);
    }
    await page.screenshot({ path: path.join(shotsDir, `${layout.name}-${layout.width}-trace.png`) });
  });
}

for (const layout of layouts.slice(0, 2)) {
  test(`${layout.name} ${layout.width}: the teardown labels do not overlap and stay on screen`, async ({ page }) => {
    test.slow(); // the eased scroll settles over many frames when the 3D view draws in software
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await open(page);
    await storyReady(page);
    for (const t of [0.5, 0.97]) {
      await scrollStory(page, at("explode", t));
      const labels = await page.locator(".story-labels li").evaluateAll((items) =>
        items
          .filter((li) => Number(getComputedStyle(li).opacity) > 0.05)
          .map((li) => {
            const { left, right, top, bottom } = li.getBoundingClientRect();
            return { part: li.getAttribute("data-part"), left, right, top, bottom };
          }),
      );
      if (t === 0.97) expect(labels, "every part is labelled at the end of the teardown").toHaveLength(13);
      for (const [i, a] of labels.entries()) {
        expect(a.left >= 0 && a.right <= layout.width && a.top >= 0 && a.bottom <= layout.height, `${a.part} on screen`).toBe(true);
        for (const b of labels.slice(i + 1)) {
          const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          expect(overlap, `${a.part} and ${b.part} at teardown ${t}`).toBe(false);
        }
      }
    }
    await page.screenshot({ path: path.join(shotsDir, `${layout.name}-${layout.width}-teardown.png`) });
  });
}

/**
 * Every pair of text blocks on screen whose text boxes overlap. A block is the header's lockup or toggle, a stage's
 * copy, the trace card, the readout, params.json, the rail, the part labels, the drawing's sizes, or the end section.
 */
const textOverlaps = (page: Page) =>
  page.evaluate(() => {
    const opacity = (el: Element | null): number => (el ? Number(getComputedStyle(el).opacity) * opacity(el.parentElement) : 1);
    const header = document.querySelector(".site-header");
    const end = document.querySelector(".end");
    if (!header || !end) throw new Error("the page has no header or end section");
    // A solid header covers what scrolls under it. The end section is opaque and slides over the story.
    const top = header.hasAttribute("data-solid") ? header.getBoundingClientRect().bottom : 0;
    const storyBottom = Math.min(innerHeight, end.getBoundingClientRect().top);
    const range = document.createRange();
    const blocks = [...document.querySelectorAll(".site-header > *, .stage-copy, .story-trace, .readout, .story-params, .story-rail, .story-labels, .story-dimensions, .end")]
      .filter((block) => opacity(block) > 0.05)
      .map((block) => {
        const inHeader = header.contains(block);
        const bottom = block.closest(".story-view") ? storyBottom : innerHeight;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const rects: DOMRect[] = [...block.querySelectorAll(".cta-primary")].map((cta) => cta.getBoundingClientRect());
        // Text cut off by a box that hides its overflow, as an ellipsis does, shows only inside that box.
        const clipOf = (from: Element | null) => {
          for (let el = from; el && block.contains(el); el = el.parentElement) {
            if (getComputedStyle(el).overflowX !== "visible") return el.getBoundingClientRect();
          }
          return null;
        };
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim() || opacity(node.parentElement) <= 0.05) continue;
          range.selectNodeContents(node);
          const clip = clipOf(node.parentElement);
          for (const r of range.getClientRects()) {
            if (!clip) rects.push(r);
            else {
              const left = Math.max(r.left, clip.left);
              const top = Math.max(r.top, clip.top);
              rects.push(new DOMRect(left, top, Math.max(0, Math.min(r.right, clip.right) - left), Math.max(0, Math.min(r.bottom, clip.bottom) - top)));
            }
          }
        }
        // Fixed text that runs past the side of the screen can never be scrolled into view.
        const width = document.documentElement.clientWidth;
        const clipped = rects.some((r) => r.width > 1 && r.bottom > top && r.top < bottom && (r.left < -1 || r.right > width + 1));
        const boxes = rects
          .map((r) => ({ left: Math.max(r.left, 0), right: Math.min(r.right, innerWidth), top: Math.max(r.top, inHeader ? 0 : top), bottom: Math.min(r.bottom, bottom) }))
          .filter((b) => b.right - b.left > 1 && b.bottom - b.top > 1);
        return { name: block.getAttribute("data-stage") ?? block.className.split(" ")[0] ?? "", boxes, clipped };
      });
    const offScreen = blocks.filter((b) => b.clipped).map((b) => `${b.name} runs past the screen edge`);
    return offScreen.concat(blocks.flatMap((a, i) =>
      blocks
        .slice(i + 1)
        .filter((b) => a.boxes.some((p) => b.boxes.some((q) => p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1)))
        .map((b) => `${a.name} covers ${b.name}`),
    ));
  });

test("no text covers other text or runs off screen on phone, desktop, short, landscape, and tablet screens, in any stage or at the end", async ({ page }) => {
  test.setTimeout(270_000); // six sizes, twelve stops each, and the 3D view may draw in software
  await page.emulateMedia({ reducedMotion: "reduce" });
  const found: string[] = [];
  const sizes = [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
    { width: 1440, height: 600 },
    { width: 844, height: 390 },
    { width: 568, height: 320 },
    { width: 768, height: 1024 },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await open(page);
    await storyReady(page);
    // One stop per stage still, then the end section coming up over the last stage.
    for (const [i, stop] of [...STAGES.map((stage) => stage.id), "end"].entries()) {
      await scrollStory(page, i * 100 + (stop === "end" ? 15 : 30));
      for (const pair of await textOverlaps(page)) found.push(`${size.width}x${size.height} ${stop}: ${pair}`);
    }
  }
  expect(found).toEqual([]);
});

test("the readout follows the scroll: parts lifted, then Z height, then the rewind clock", async ({ page }) => {
  test.slow(); // the eased scroll settles over many frames when the 3D view draws in software
  await open(page);
  await storyReady(page);
  expect(await readout(page)).toEqual({ kick: "Parts lifted", value: "00/12", line: "Assembled" });

  await scrollStory(page, at("explode", 0.97));
  expect(await readout(page)).toEqual({ kick: "Parts lifted", value: "12/12", line: "Build plate, textured PEI" });

  await scrollStory(page, at("print", 0.6));
  const printing = await readout(page);
  expect(printing.kick).toBe("Z height");
  expect(printing.value).toMatch(/^\d{1,2}\.\d{2}mm$/);
  expect(printing.line).toMatch(/^Layer \d{3} \/ 150$/);

  await scrollStory(page, at("guide", 0.75));
  expect(await readout(page)).toEqual({ kick: "Elapsed", value: "9:47", line: "Wrote assembly-guide.html, 13 steps." });
});

test("the 3D view survives a reduced-motion change while the page is open", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await storyReady(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await storyReady(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await storyReady(page);
  expect(errors).toEqual([]);
});

test("at the end, the header is solid over the install guide and the hidden rail is out of the tab order", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await page.locator('a[href="#install"]').first().evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page.locator(".site-header"), "the header turns solid after an instant jump").toHaveAttribute("data-solid", "true");
  const headerBottom = await page.locator(".site-header").evaluate((h) => h.getBoundingClientRect().bottom);
  const installTop = await page.locator("#install-title").evaluate((h) => h.getBoundingClientRect().top);
  expect(installTop, "the Install heading sits below the header").toBeGreaterThanOrEqual(headerBottom - 1);

  await page.locator(".end .cta-primary").first().focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".story-rail"))), "Shift+Tab skips the hidden rail").toBe(false);
});

test("search and share tags point at the live site, and robots, sitemap, and share image are served", async ({ page, request }) => {
  await open(page);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://materialize-3d.pages.dev/");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://materialize-3d.pages.dev/og-image.png");

  // The preview, like the live host, answers a missing file with the page itself, so a 200 alone proves nothing.
  const served = { "robots.txt": "text/plain", "sitemap.xml": "xml", "og-image.png": "image/png" };
  for (const [file, type] of Object.entries(served)) {
    const response = await request.get(file);
    expect(response.status(), file).toBe(200);
    expect(response.headers()["content-type"], file).toContain(type);
  }
});

test("release claims match the release flags", async ({ page }) => {
  await open(page);
  const text = await page.locator("body").innerText();

  expect(text).not.toMatch(/disable gatekeeper|gatekeeper off|spctl|master-disable|xattr/i);
  if (!appleTrusted) {
    expect(text).not.toMatch(/signed and notarized|notarized by apple|signed by apple|apple[- ]notarized/i);
  }
  if (!release.signed) expect(text).toContain("Not signed yet");
  if (!release.notarized) expect(text).toContain("Not notarized yet");
  if (!checksumPublished) {
    expect(text).toContain("Not published yet");
    expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
  }
  if (appleTrusted) {
    expect(text).toMatch(/signed and notarized by apple/i);
    expect(text).not.toMatch(/open anyway/i);
  }
  if (checksumPublished) expect(text).toContain(release.sha256);
});
