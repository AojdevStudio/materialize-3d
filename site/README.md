# Materialize 3D landing site

A single static page that explains Materialize 3D 0.1.0 and offers the Mac download. Vite, React, TypeScript, and plain CSS. It builds to plain files in `dist/` for any static host.

## Commands

```sh
bun install
bun run dev                               # local dev server
bun run build                             # type-check, then build to dist/
SITE_BASE=/materialize-3d/ bun run build  # build for a host that serves under a subpath
bunx playwright install chromium          # once per machine
bunx playwright test                      # builds with SITE_BASE=/materialize-3d/ and tests the preview
```

`SITE_BASE` sets the public path. Unset means the site is served from `/`.

## Release facts

Every release fact lives in `src/release.ts`: version, repository, releases, docs, and DMG URLs, the DMG SHA-256, the `signed` and `notarized` flags, the tested macOS text, and the architecture. Edit only that file after a release is verified.

The page renders the honest state of those values. The SHA-256 row reads "Not published yet" while the value is `pending`. The phrase "Signed and notarized by Apple" appears only when both flags are true. While `notarized` is false, the install steps tell people to use Open Anyway in System Settings, Privacy & Security. The page never tells anyone to disable Gatekeeper.

## Design direction

Mobbin research was not available for this project, so this is an original design direction. It extends the app's own identity: the orange accent, the italic Instrument Serif "Materialize" wordmark, DM Sans for text, and JetBrains Mono for technical detail. The page opens in light mode. The dark mode toggle is remembered in `localStorage` and uses pure black with white text. On white, the orange is darkened from the app's `#e8682a` so text and the download button pass WCAG AA contrast.

Three hero and download directions are in `mocks/`:

- `a-spec-sheet.html`: an oversized wordmark with the download laid out as a monospace release record.
- `b-split-proof.html`: copy and download on the left, the real 27 of 27 checks screenshot on the right.
- `c-stage-track.html`: a centered pipeline track with the rendered test sign as the hero image.

I picked B because it puts the real app screenshot showing 27 of 27 passed checks beside the download, so the first screen carries its own proof. It keeps the release status (checksum, signing, notarization) directly under the button, where a visitor cannot miss the honest state. A spends the first screen on the wordmark and shows no product, and C's rendered sign reads as a marketing image instead of evidence from the app.

## Fonts

The fonts in `src/assets/fonts/` are copied from the app. They are licensed under the SIL Open Font License 1.1, and the license text with each copyright line is in `src/assets/fonts/OFL.txt`. The build ships that file with the fonts, and the page footer links to it.

## Tests

`tests/site.spec.ts` covers:

- no horizontal overflow at 1440 and 390 px in both themes
- the download link is the first action and points at the configured DMG
- every in-page anchor and internal link resolves under the base path
- off-site links are exactly the configured set
- keyboard focus reaches every link and the theme toggle, with a visible focus ring
- axe finds no violations in either theme
- no signing or notarization claim appears while the flags are false

The layout tests also save full-page screenshots to `test-results/screens/`, which is gitignored. The tests never fetch GitHub. CI runs them in the `Landing site` job.

## Deploy

The site is a Cloudflare Pages project named `materialize-3d`, deployed by hand from `main` after a release is published and `src/release.ts` carries its checksum. No deploy credential is stored in GitHub.

```sh
cd site && bun install --frozen-lockfile && bun run build
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bunx wrangler pages deploy dist --project-name materialize-3d --branch main
```
