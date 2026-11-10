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

Every release fact lives in `src/release.ts`: version, repository, releases, docs, and DMG URLs, the DMG SHA-256, the `signed` and `notarized` flags, the tested macOS text, the architecture, and the `studio` flag. Edit only that file after a release is verified. A merge to `main` deploys the site, so an edit to `src/release.ts` goes live as soon as it merges. Merge it only after the release is verified.

The page renders the honest state of those values. While `studio` is false, the page says next to each download that the chat studio is not in a release yet and names the version the download is. The SHA-256 row reads "Not published yet" while the value is `pending`. The phrase "Signed and notarized by Apple" appears only when both flags are true. While `notarized` is false, the install steps tell people to use Open Anyway in System Settings, Privacy & Security. The page never tells anyone to disable Gatekeeper.

## Design direction

The page is a scroll story Ossie picked: one 3D printer is the spine, and the scroll position drives everything. The printer is the show. The words over it say what the app is: a chat app where an agent designs a part and makes the print file. They never narrate the printer. In order, the stages are:

1. The printer, assembled, with the title and the download.
2. The teardown: twelve parts lift off top down, each with a numbered leader label. The words say what the app is.
3. The dive onto the build plate, where the agent's work ends.
4. The print: the right shelf of a dock mount prints layer by layer, and the readout counts Z height. The words say one chat made it.
5. The rewind, 13:58 back to 0:00. The studio's own trace card stands in for the words: the six steps of the agent's turn, a line leaving from the bottom at each step back (the slices, the assembly guide, the revision C adapter, the five parts, the drawing, params.json). It ends on the studio's start screen with the request typed.
6. The end section: download, release facts, how it works, requirements, and install.

Light is the default, a paper-white page with oxblood as the one accent. The dark mode toggle is remembered in `localStorage` and uses true black with white text. All text is DOM text, and axe checks it in both themes.

The story lives in `src/story/`:

- `timeline.ts` is the stage table. Each row sets a stage's scroll length, its reduced-motion still, its rail stop, its readout, what tells it (its own copy or the trace card), its copy fades, and its agent log line. A rewind row's log line is also its trace step. The camera keys, the readout, and the trace card hang off the same stage ids. Everything is plain math on one number, the story position.
- `parts.ts` is the teardown table: each part's label, leader anchor, label side, and lift turn.
- `facts.ts` reads the dock mount's sizes from `dock-data.json` once. `assets.ts` loads the GLBs and the slice outlines once.
- `scene.ts` is the three.js scene. `director.ts` maps the scroll to the story position and writes the copy, labels, readout, trace card, and rail. `ScrollStory.tsx` renders all of it as DOM.

Short and narrow screens keep every line readable. Below 1024 px wide params.json moves beside the copy column. On a short screen the readout steps aside while a copy block it would cover is showing, and below 540 px tall it hides. A phone held sideways keeps the desktop arrangement with the phone type.

three.js, the models, and the slice outlines load in their own chunk after the page shows. The page draws only while the story position moves, so nothing repaints while the reader is still. Under reduced motion each stage is one still: the scroll steps from stage to stage, and nothing moves in between.

## The 3D models

`src/assets/story/` holds the models and their data. The scripts in `models/` make them, and rebuilding gives the same bytes. Run these from `site/models`, with Blender 5.2 and uv:

```sh
uv run --with manifold3d --with numpy python dock/dock_mesh.py   # dock-data.json, dock-slices.json, dock/meshes.json
blender -b --python blender/build_dock.py                         # dock.glb
blender -b --python blender/build_printer.py                      # printer.glb, printer-parts.json
blender -b --python blender/build_printer.py -- --render          # also Cycles stills in models/renders/
```

The printer has P2S proportions (392 x 406 x 478 mm, a 256 mm plate) and no logo or wordmark. The dock mount comes from the agent's own build scripts and params.json, copied into `models/dock/`. `dock/meshes.json` and `renders/` are build output and stay out of git.

## Fonts and third-party material

The page uses Inter, copied from the app. It is licensed under the SIL Open Font License 1.1. The license text with its copyright line is in `src/assets/fonts/OFL.txt`, which the build ships and the page footer links to.

The 3D view uses three.js (MIT), installed as a package and bundled into the story chunk.

The trace card and the composer use Lucide line icons (ISC) from lucide-static 1.70.0, in `src/assets/icons/`. The trace icons are the files the studio ships in `src/assets/icons/` at the repository root. Each file keeps its license comment, which the build carries into the page. The repository's `THIRD_PARTY_NOTICES.md` holds the full license text.

## Search and sharing

`index.html` carries the description, the canonical URL, and the Open Graph and Twitter card tags. Every URL in them is absolute and points at `https://materialize-3d.pages.dev/`. Vite copies `public/` into the root of `dist/` as is: `robots.txt` allows all crawlers and names the sitemap, `sitemap.xml` lists the one page, and `og-image.png` is the 1200 by 630 share image. Remake the image from the repository root with this command:

```sh
magick docs/images/studio-light.png -resize 1152x582 -background '#CFD0CF' -gravity center -extent 1200x630 -strip site/public/og-image.png
```

The tags and files go live with the next production deployment.

## Tests

`tests/site.spec.ts` covers:

- no horizontal overflow at 1440, 390, and 320 px in both themes, at the top and at the end section
- the download link is the first action and points at the configured DMG
- every in-page anchor and internal link resolves under the base path
- off-site links are exactly the configured set
- keyboard focus reaches every link and button, with a visible focus ring
- axe finds no violations in either theme
- How it works shows Describe, Make, Look, and Print in order, and the page says no release has the studio yet
- with reduced motion, each stage shows only its own copy, in order, and nothing moves while scrolling through it. Each rewind still shows the trace card with its own kick, head, and lines, one fewer at each step back
- the trace card covers no pixel of the 3D view in any rewind still, at 1440 and 390
- the teardown labels never overlap and stay on screen, at 1440 and 390
- no visible text covers other text at 390 x 844, 1440 x 900, 1440 x 600, 844 x 390, 568 x 320, and 768 x 1024, in any stage or as the end section comes up
- the readout follows the scroll: parts lifted, then Z height, then the rewind clock
- no signing or notarization claim appears while the flags are false
- the head carries the canonical URL and an absolute share image, and the preview serves `robots.txt`, `sitemap.xml`, and `og-image.png` as real files

The layout and label tests also save screenshots to `test-results/screens/`, which is gitignored. The tests never fetch GitHub. CI runs them in the `Landing site` job.

## Deploy

The site is the Cloudflare Pages project `materialize-3d`, served at https://materialize-3d.pages.dev. Cloudflare's Git connection builds and deploys it: every push to `main` deploys production, and every other branch gets a preview deployment. GitHub holds no Cloudflare credential.

The project's build settings in the Cloudflare dashboard:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `site` |
| Build command | `bun install --frozen-lockfile && bun run build` |
| Build output directory | `dist` |
| Environment variable | `BUN_VERSION` = `1.4.4`, the version CI pins |

Leave `SITE_BASE` unset, because Pages serves the site from `/`. Cloudflare runs no tests. The `Landing site` CI job runs the site tests on pull requests from this repository. It skips forks and Dependabot, and the merge rules do not require it.
