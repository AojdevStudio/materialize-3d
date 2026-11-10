# Materialize 3D landing site

A single static page that explains the Materialize 3D chat studio and offers the Mac download. The download is the release named in `src/release.ts`. Vite, React, TypeScript, and plain CSS. It builds to plain files in `dist/` for any static host.

## Commands

```sh
bun install
bun run dev                               # local dev server
bun run build                             # type-check, then build to dist/
SITE_BASE=/materialize-3d/ bun run build  # build for a host that serves under a subpath
bunx playwright test                      # builds with SITE_BASE=/materialize-3d/ and tests the preview
```

The tests launch the installed Google Chrome with its sandbox on, not Playwright's bundled Chromium. Google Chrome must be in its standard location: `/Applications/Google Chrome.app` on macOS, `/opt/google/chrome` on Linux.

`SITE_BASE` sets the public path. Unset means the site is served from `/`.

## Release facts

Every release fact lives in `src/release.ts`: version, repository, releases, docs, and DMG URLs, the DMG SHA-256, the `signed` and `notarized` flags, the tested macOS text, the architecture, and the `studio` flag. Edit only that file after a release is verified.

The page renders the honest state of those values. While `studio` is false, the hero says the chat studio is not in a release yet and names the version the download is. The SHA-256 row reads "Not published yet" while the value is `pending`. The phrase "Signed and notarized by Apple" appears only when both flags are true. While `notarized` is false, the install steps tell people to use Open Anyway in System Settings, Privacy & Security. The page never tells anyone to disable Gatekeeper.

## Design direction

The page is the "Landing D2" frame Ossie picked in the app's design file: a concrete-gray band (`#CFD0CF`) under the header and hero, a centered headline with "Print the 3MF." in oxblood, a bento for How it works, then requirements, install, and a closing call to action. Light is the default. The dark mode toggle is remembered in `localStorage` and uses true black with white text. The product pictures, the hero window and the bento UI, stay light in both themes, the way the app opens. Every text pair passes WCAG AA, and axe checks it in both themes.

The hero is an animated faux Materialize 3D window built with the stageshow kit, in `src/hero/`. One loop of about 14 seconds tells one job: a request is typed, the agent works through six steps, the assembly guide opens, and the dock mount lands in Ready to print with its print files. It plays only while on screen. Under reduced motion it shows that last frame and does not move. `src/hero/REHEARSAL.md` records how it was filmed and checked.

## Fonts and third-party material

The page uses Inter, copied from the app. It is licensed under the SIL Open Font License 1.1. The license text with its copyright line is in `src/assets/fonts/OFL.txt`, which the build ships and the page footer links to.

The stageshow kit in `src/stageshow/kit/` is MIT licensed, and its license is in `src/stageshow/LICENSE`. TypeScript checks it under its own settings (`tsconfig.stageshow.json`), so the page's stricter settings do not apply to vendored code.

The sidebar icons in the hero (`src/assets/landing/line-*.svg`) are the app's outline icons from Streamline, licensed under CC BY 4.0. The repository's `THIRD_PARTY_NOTICES.md` credits them.

## Tests

`tests/site.spec.ts` covers:

- no horizontal overflow at 1440 and 390 px in both themes
- the download link is the first action and points at the configured DMG
- every in-page anchor and internal link resolves under the base path
- off-site links are exactly the configured set
- keyboard focus reaches every link and the theme toggle, with a visible focus ring
- axe finds no violations in either theme
- How it works shows the Describe, Make, Look, and Print tiles in order, and the page says no release has the studio yet
- with reduced motion, the hero shows the finished part and holds still
- no signing or notarization claim appears while the flags are false

The layout tests also save full-page screenshots to `test-results/screens/`, which is gitignored. The tests never fetch GitHub. CI runs them in the `Landing site` job.

## Deploy

The site is a Cloudflare Pages project named `materialize-3d`, deployed by hand from `main` after a release is published and `src/release.ts` carries its checksum. No deploy credential is stored in GitHub.

```sh
cd site && bun install --frozen-lockfile && bun run build
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bunx wrangler pages deploy dist --project-name materialize-3d --branch main
```
