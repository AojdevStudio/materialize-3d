# Site

The landing site in `site/` is a static page that explains Materialize 3D and offers the Mac download, plus a privacy page at `/privacy`. The landing page is a scroll story built with three.js (`site/src/story/`): a 3D printer comes apart top down, the right shelf of a dock mount prints on its plate, and the story rewinds through the studio's trace card to its start screen with the request typed, then ends on the download. The words over the printer say what the app is. Its Playwright tests build it under the `/materialize-3d/` subpath, serve the preview, and check layout, links, keyboard focus, accessibility, and the release claims. Since PR 120 they run on the installed Google Chrome with its sandbox on, not on Playwright's bundled Chromium.

## Sub-features

- `site-layout` covers no horizontal overflow at 1440, 390, and 320 px wide, in light and dark.
- `site-links` covers the download as the first prominent action, every in-page anchor and internal link, the exact set of external links, and the footer's legal line (copyright, Blog, Privacy, MIT license).
- `site-privacy` covers the privacy page at `/privacy`: its text, the shared header and footer, axe, and its sitemap entry, in both themes.
- `site-a11y` covers keyboard focus on every link and button, and axe in both themes on the reduced-motion story.
- `site-release` covers the release claims that follow the flags in `site/src/release.ts`.
- `site-story` covers How it works in order (Describe, Make, Look, Print), the readout that follows the scroll, and teardown labels that never overlap at 1440 and 390 px.
- `site-motion` covers reduced motion at 1440 and 390 px: each stage is one still, shown in story order, and each rewind still shows the trace card with one fewer line per step back. The card covers no pixel of the 3D view at eight sizes, from 320x568 to 1440x900, upright and wide.

## How to get to it (user POV)

- A visitor opens the published page. For verification, the tests serve the production build at `http://127.0.0.1:4173/materialize-3d/`.

## Driving it with wd.ts

`wd.ts` does not drive the site. Playwright does, from `site/`, with Bun 1.4.4:

```bash
cd site
bun install --frozen-lockfile
bunx playwright test
```

Preconditions:

- Google Chrome at its standard location: `/opt/google/chrome/chrome` on Linux, `/Applications/Google Chrome.app` on macOS. `channel: "chrome"` in `site/playwright.config.ts` looks only there.
- Port 4173 free.

- **dev-substrate (observed 2026-11-10).** With Bun 1.4.4 and Google Chrome 157.0.8103.50, all 28 tests pass in about 2.2 minutes with 4 workers.
- **aojdevlinux (observed 2026-11-03).** All 11 tests fail with "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome", because Chrome is installed at `~/.local/opt/google-chrome`. Run the tests on dev-substrate, or link Chrome into `/opt/google/chrome` (that needs sudo). A scratch Playwright config outside the repo that drops `channel` and sets `launchOptions.executablePath` to `~/.local/opt/google-chrome/chrome` runs them there **(observed 2026-11-10)**. Run with 4 workers or fewer, since more time out drawing the 3D view in software.
- **CI.** The `Landing site` job runs on a self-hosted Mac (`runs-on: [self-hosted, macOS, ARM64, m3d-mac-vz]`) with its own Bun under the job's temp directory, see `.github/workflows/ci.yml`. Its comment says dev-substrate has no Chrome, which no longer holds.

## Gotchas

- The tests run `bun run build` themselves through Playwright's `webServer`, so a stale `dist/` does not matter.
- `test-results/` and `node_modules/` are ignored, so a run leaves the tree clean.
- The page describes the chat studio, but `site/src/release.ts` still points the download at 0.1.0. Until a release carries the studio, the hero says so.
- The 3D view renders with WebGL. Headless Chrome draws it in software (SwiftShader), so the eased scroll takes a few seconds to settle. The tests wait until the story stops writing to the page before they measure.
