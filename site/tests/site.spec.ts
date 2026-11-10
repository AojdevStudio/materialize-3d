import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { appleTrusted, checksumPublished, externalLinks, release } from "../src/release";

type Theme = "light" | "dark";

const shotsDir = path.resolve(import.meta.dirname, "../test-results/screens");

/** Start the page in a given theme the way a returning visitor would: via the remembered choice. */
async function open(page: Page, theme: Theme = "light") {
  if (theme === "dark") await page.addInitScript(() => localStorage.setItem("m3d-theme", "dark"));
  await page.goto("./");
}

async function loadAllImages(page: Page) {
  return page.evaluate(async () => {
    const imgs = [...document.images];
    for (const img of imgs) img.loading = "eager";
    // A failed decode surfaces as naturalWidth 0, which the caller asserts on.
    await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
    return imgs.filter((img) => img.naturalWidth === 0).map((img) => img.src);
  });
}

/** Pixels that differ between two PNG screenshots of the same box, counted in the page. */
async function changedPixels(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(async ([pngA, pngB]) => {
    const pixels = async (png: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [x, y] = await Promise.all([pixels(pngA), pixels(pngB)]);
    if (x.length !== y.length) throw new Error("the two frames differ in size");
    let changed = 0;
    for (let i = 0; i < x.length; i += 4) {
      if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) changed++;
    }
    return changed;
  }, [a.toString("base64"), b.toString("base64")] as const);
}

/**
 * The hero holds still: once its images have decoded and its frame has settled, at most 100 pixels change in
 * two seconds. Chrome on the macOS runner redraws a scaled image at higher quality about a second after the page
 * goes idle, and its anti-aliasing flickers single pixels, so settling waits 1.5 s between frames and the bound
 * allows that noise. The running loop changes over 100,000 pixels in the same two seconds.
 */
async function expectHeroHoldsStill(page: Page) {
  const hero = page.locator(".hero-stage");
  // The stage mounts again once Inter loads (ProductHero), so wait for that render before decoding its images.
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
  await hero.locator("img").evaluateAll((imgs) => Promise.all(imgs.map((img) => (img as HTMLImageElement).decode())));
  await expect(async () => {
    const first = await hero.screenshot();
    await page.waitForTimeout(1500);
    expect(await changedPixels(page, first, await hero.screenshot()), "pixels still changing while the hero settles").toBeLessThanOrEqual(100);
  }).toPass({ timeout: 20_000 });
  const before = await hero.screenshot();
  await page.waitForTimeout(2000);
  expect(await changedPixels(page, before, await hero.screenshot()), "pixels that changed in two seconds").toBeLessThanOrEqual(100);
}

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
      expect(await loadAllImages(page), "images that failed to load").toEqual([]);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      await page.screenshot({
        path: path.join(shotsDir, `${layout.name}-${layout.width}-${theme}.png`),
        fullPage: true,
      });
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
  await expect(page.locator('button[aria-pressed][data-kb]')).toHaveCount(1);
});

for (const theme of ["light", "dark"] as const) {
  test(`axe reports no violations in ${theme} theme, with the hero on its finished frame`, async ({ page }) => {
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
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  });
}

test("how it works tells the chat studio story in order, and the page says no release has it yet", async ({ page }) => {
  await open(page);
  await expect(page.locator("#how .tile-title")).toHaveText(["Describe", "Make", "Look", "Print"]);
  const text = await page.locator("body").innerText();
  expect(text).toContain("The chat studio is not in a release yet.");
  expect(text).toContain(`This download is ${release.version}, the earlier sign app.`);
  expect(text).not.toMatch(/\bMCP\b/);
});

for (const layout of layouts) {
  test(`${layout.name} ${layout.width}: with reduced motion the hero shows the finished part and holds still`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await page.evaluate(() => document.fonts.ready);
    const hero = page.locator(".hero-stage");
    const payoff = hero.getByText("2 print files ready").last();
    expect(await payoff.evaluate((el) => el.checkVisibility({ opacityProperty: true })), "print files card shown").toBe(true);

    const part = hero.locator('img[src*="dock-mount-model"]');
    expect(await part.evaluate((el) => el.checkVisibility({ opacityProperty: true })), "model render shown").toBe(true);
    const [partBox, heroBox] = await Promise.all([part.boundingBox(), hero.boundingBox()]);
    if (!partBox || !heroBox) throw new Error("the model render or the hero has no layout box");
    expect(partBox.x, "render starts inside the hero").toBeGreaterThanOrEqual(heroBox.x);
    expect(partBox.x + partBox.width, "render ends inside the hero").toBeLessThanOrEqual(heroBox.x + heroBox.width);
    expect(partBox.y + partBox.height, "render ends above the hero's foot").toBeLessThanOrEqual(heroBox.y + heroBox.height);

    await expectHeroHoldsStill(page);
  });
}

test("the pause control stops the hero on its finished frame", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Pause animation" }).click();
  await expect(page.getByRole("button", { name: "Play animation" })).toBeVisible();
  const hero = page.locator(".hero-stage");
  const payoff = hero.getByText("2 print files ready").last();
  expect(await payoff.evaluate((el) => el.checkVisibility({ opacityProperty: true })), "print files card shown").toBe(true);
  await expectHeroHoldsStill(page);
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
