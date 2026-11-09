# Site

The landing site in `site/` is one static page that explains Materialize 3D and offers the Mac download. Its Playwright tests build it under the `/materialize-3d/` subpath, serve the preview, and check layout, links, keyboard focus, accessibility, and the release claims. Since PR 120 they run on the installed Google Chrome with its sandbox on, not on Playwright's bundled Chromium.

## Sub-features

- `site-layout` covers no horizontal overflow at 1440 and 390 px wide, in light and dark.
- `site-links` covers the download as the first prominent action, every in-page anchor and internal link, and the exact set of external links.
- `site-a11y` covers keyboard focus on every link and the theme toggle, and axe in both themes.
- `site-release` covers the release claims that follow the flags in `site/src/release.ts`.
- `site-story` covers the four How it works steps in order: Talk to it, Preview, Assembly guide, 3MF to Bambu Studio.

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

- **dev-substrate (observed 2026-11-09).** With Bun 1.4.4 and Google Chrome 157.0.8103.38, all 12 tests pass in about 5 seconds, and `git status --short` is unchanged afterwards.
- **aojdevlinux (observed 2026-11-03).** All 11 tests fail with "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome", because Chrome is installed at `~/.local/opt/google-chrome`. Run the tests on dev-substrate, or link Chrome into `/opt/google/chrome` (that needs sudo).
- **CI.** The `Landing site` job runs on a self-hosted Mac (`runs-on: [self-hosted, macOS, ARM64, m3d-mac-vz]`) with its own Bun under the job's temp directory, see `.github/workflows/ci.yml`. Its comment says dev-substrate has no Chrome, which no longer holds.

## Gotchas

- The tests run `bun run build` themselves through Playwright's `webServer`, so a stale `dist/` does not matter.
- `test-results/` and `node_modules/` are ignored, so a run leaves the tree clean.
- The page describes the chat studio, but `site/src/release.ts` still points the download at 0.1.0. Until a release carries the studio, the hero says so.
