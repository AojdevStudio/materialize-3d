# Site

The landing site in `site/` is a static page that explains Materialize 3D and offers the Mac download, plus a privacy page at `/privacy`. The landing page is a scroll story built with three.js (`site/src/story/`): a 3D printer comes apart top down, the right shelf of a dock mount prints on its plate, and the story rewinds through the studio's trace card to its start screen with the request typed, then ends on the download. The words over the printer say what the app is. Its Playwright tests build it under the `/materialize-3d/` subpath, serve the preview, and check layout, links, keyboard focus, accessibility, and the release claims. Since PR 120 they run on the installed Google Chrome with its sandbox on, not on Playwright's bundled Chromium.

## Sub-features

- Each test's title in `site/tests/site.spec.ts` names what it covers. `bunx playwright test --list`, run from `site/`, prints them.

## How to get to it (user POV)

- A visitor opens the published page. For verification, the tests serve the production build at `http://127.0.0.1:4173/materialize-3d/`.

## Driving it with wd.ts

`wd.ts` does not drive the site. Playwright does, from `site/`, with the Bun that CI pins:

```bash
cd site
bun install --frozen-lockfile
bunx playwright test
```

Preconditions:

- Google Chrome at its standard location: `/opt/google/chrome/chrome` on Linux, `/Applications/Google Chrome.app` on macOS. `channel: "chrome"` in `site/playwright.config.ts` looks only there.
- Port 4173 free.

- **dev-substrate (observed 2026-11-10).** With Bun 1.4.4 and Google Chrome 157.0.8103.50, all 28 tests pass in about 2.2 minutes with 4 workers.
- **aojdevlinux (observed 2026-11-24).** `site/playwright.config.ts` runs 2 workers. With Bun 1.4.4, all 34 tests passed six runs in a row in about 3 minutes each, at a load average of 23 to 38 on 16 cores. With 16 extra busy loops (load 40 to 63), 5 to 7 tests still time out, because the first 3D frame alone takes over 30 seconds. Run it with `TMPDIR=/tmp`, because Chrome fails with "Socket path too long" under a deep `TMPDIR`.
- **Port 4173 is shared.** Two gates on one host collide on it, and the second run stops at once with "is already used". Wait for the other run to end.
- **CI.** The `Landing site` job runs on a self-hosted Mac (`runs-on: [self-hosted, macOS, ARM64, m3d-mac-vz]`) with its own Bun under the job's temp directory, see `.github/workflows/ci.yml`.

## Gotchas

- The tests run `bun run build` themselves through Playwright's `webServer`, so a stale `dist/` does not matter.
- `test-results/` and `node_modules/` are ignored, so a run leaves the tree clean.
- The release claims the tests check come from `site/src/release.ts`, which describes the last published release. It trails `package.json` while the next release is built.
- The 3D view renders with WebGL. Headless Chrome on Linux draws it in software (SwiftShader). Under load one frame can hold the page's main thread for 10 to 26 seconds. After each settled frame the story writes the scroll offset it shows to the canvas's `data-drawn`. The tests wait for it to equal `scrollY` before they measure.
- More workers do not finish sooner, because one software-drawn page keeps every core busy. They only stretch each test past its timeout.
