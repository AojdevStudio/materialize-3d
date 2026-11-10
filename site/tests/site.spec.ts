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

/**
 * Watches the hero for `ms` and returns what moved. Runs in the page on every frame, so it sees every change
 * rather than samples: any DOM mutation on or inside the hero, any CSS animation or transition that starts or
 * runs on it, inside it, or on an element around it, any shift in where the hero and its parts render, and the
 * hero leaving the page.
 */
function watchHero(hero: Element, ms: number) {
  const inside = (node: Node | null) => node !== null && (node === hero || hero.contains(node));
  const around = (node: Node | null) => inside(node) || (node !== null && node.contains(hero));
  const moved: string[] = [];
  const note = (what: string) => {
    if (moved.length < 5 && !moved.includes(what)) moved.push(what);
  };
  const parts = [hero, ...hero.querySelectorAll("img, svg, .ss-window, [class*='m3h-']")];
  const where = (part: Element) => {
    const box = part.getBoundingClientRect();
    return `${box.x},${box.y},${box.width},${box.height}`;
  };
  const start = new Map(parts.map((part) => [part, where(part)]));
  const runningNow = () =>
    document.getAnimations().filter((animation) => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      return animation.playState === "running" && around(target);
    });
  for (const animation of runningNow()) note(`running at the start: ${animation.constructor.name}`);
  const observer = new MutationObserver((records) => {
    for (const record of records) if (inside(record.target)) note(`${record.type} on ${record.target.nodeName}`);
  });
  observer.observe(hero, { subtree: true, attributes: true, childList: true, characterData: true });
  const onStart = (event: Event) => {
    if (around(event.target as Node)) note(`${event.type} on ${(event.target as Element).nodeName}`);
  };
  const starts = ["animationstart", "animationiteration", "transitionrun"] as const;
  for (const type of starts) document.addEventListener(type, onStart, true);
  return new Promise<string[]>((done) => {
    const end = performance.now() + ms;
    const frame = () => {
      if (!hero.isConnected) note("the hero left the page");
      for (const animation of runningNow()) note(`running: ${animation.constructor.name}`);
      for (const part of parts) {
        if (where(part) !== start.get(part)) note(`moved: ${part.nodeName}.${part.getAttribute("class") ?? ""}`);
      }
      if (performance.now() < end) return requestAnimationFrame(frame);
      observer.disconnect();
      for (const type of starts) document.removeEventListener(type, onStart, true);
      done(moved);
    };
    requestAnimationFrame(frame);
  });
}

/**
 * The hero holds still: once Inter has loaded and the stage has mounted again for it (ProductHero), nothing in it
 * changes, animates, or shifts for 6 s, longer than the loop's longest hold (4 s on the payoff).
 */
async function expectHeroHoldsStill(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
  const hero = page.locator(".hero-stage");
  await expect.poll(() => hero.evaluate(watchHero, 1000), { message: "the hero settles", timeout: 15_000 }).toEqual([]);
  expect(await hero.evaluate(watchHero, 6000), "what moved on, in, or around the hero in 6 s").toEqual([]);
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
