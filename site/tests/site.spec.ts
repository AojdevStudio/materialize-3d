import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { appleTrusted, checksumPublished, externalLinks, release } from "../src/release";
import { STAGES, at } from "../src/story/timeline";

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

for (const layout of layouts.slice(0, 2)) {
  test(`${layout.name} ${layout.width}: with reduced motion each stage is one still, in story order`, async ({ page }) => {
    test.slow(); // 22 screenshots, and the 3D view may draw in software
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await storyReady(page);
    const shownCopy = () =>
      page.locator(".stage-copy").evaluateAll((blocks) => blocks.filter((b) => getComputedStyle(b).opacity === "1").map((b) => b.getAttribute("data-stage")));

    for (const [i, stage] of STAGES.entries()) {
      await scrollStory(page, i * 100 + 30);
      expect(await shownCopy(), `stage ${i + 1} shows only its own copy`).toEqual([stage.id]);
      const early = await page.screenshot();
      await scrollStory(page, i * 100 + 70);
      expect(early.equals(await page.screenshot()), `nothing moves while scrolling through ${stage.id}`).toBe(true);
    }
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
