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

const layouts = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
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
  test(`axe reports no violations in ${theme} theme`, async ({ page }) => {
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
