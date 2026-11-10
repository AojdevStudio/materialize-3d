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

The page is a scroll story Ossie picked: one 3D printer is the spine, and the scroll position drives everything. In order, the stages are:

1. The printer, assembled, with the title, the download, and its outer size.
2. The teardown: twelve parts lift off top down, each with a numbered leader label.
3. The dive onto the build plate.
4. The print: the right shelf of a dock mount prints layer by layer, and the readout counts Z height.
5. The rewind through the agent log, 13:58 back to 0:00: the slices, the assembly guide, the revision C adapter, the five parts, the drawing, params.json, and the request.
6. The end section: download, release facts, how it works, requirements, and install.

Light is the default, a paper-white page with oxblood as the one accent. The dark mode toggle is remembered in `localStorage` and uses true black with white text. All text is DOM text, and axe checks it in both themes.

The story lives in `src/story/`:

- `timeline.ts` is the stage table. Each row sets a stage's scroll length, its reduced-motion still, its rail stop, its readout, its copy fades, and its agent log line. The camera keys and the readout hang off the same stage ids. Everything is plain math on one number, the story position.
- `parts.ts` is the teardown table: each part's label, leader anchor, label side, and lift turn.
- `facts.ts` reads the dock mount's sizes from `dock-data.json` once. `assets.ts` loads the GLBs and the slice outlines once.
- `scene.ts` is the three.js scene. `director.ts` maps the scroll to the story position and writes the copy, labels, readout, log, and rail. `ScrollStory.tsx` renders all of it as DOM.

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

## Search and sharing

`index.html` carries the description, the canonical URL, and the Open Graph and Twitter card tags. Every URL in them is absolute and points at `https://materialize-3d.pages.dev/`. Vite copies `public/` into the root of `dist/` as is: `robots.txt` allows all crawlers and names the sitemap, `sitemap.xml` lists the one page, and `og-image.png` is the 1200 by 630 share image. Remake the image from the repository root with this command:

```sh
magick docs/images/studio-light.png -resize 1152x582 -background '#CFD0CF' -gravity center -extent 1200x630 -strip site/public/og-image.png
```

The tags and files go live at the next manual deploy.

## Tests

`tests/site.spec.ts` covers:

- no horizontal overflow at 1440, 390, and 320 px in both themes, at the top and at the end section
- the download link is the first action and points at the configured DMG
- every in-page anchor and internal link resolves under the base path
- off-site links are exactly the configured set
- keyboard focus reaches every link and button, with a visible focus ring
- axe finds no violations in either theme
- How it works shows Describe, Make, Look, and Print in order, and the page says no release has the studio yet
- with reduced motion, each stage shows only its own copy, in order, and nothing moves while scrolling through it
- the teardown labels never overlap and stay on screen, at 1440 and 390
- the readout follows the scroll: parts lifted, then Z height, then the rewind clock
- no signing or notarization claim appears while the flags are false
- the head carries the canonical URL and an absolute share image, and the preview serves `robots.txt`, `sitemap.xml`, and `og-image.png` as real files

The layout and label tests also save screenshots to `test-results/screens/`, which is gitignored. The tests never fetch GitHub. CI runs them in the `Landing site` job.

## Deploy

The site is the Cloudflare Pages project `materialize-3d`, served at https://materialize-3d.pages.dev. It deploys on its own when a merge to `main` touches `site/`. The workflow is `.github/workflows/site-deploy.yml`, and its job is `Deploy the landing site`. It runs on the Mac mini runner.

The job runs these steps in order:

1. It checks that the two repository secrets are set, and fails at once with an error that names a missing one.
2. It runs the site tests (`bunx playwright test`). A build that fails them never deploys.
3. It builds `dist/` again with `SITE_BASE` unset, because Pages serves the site from `/`.
4. It deploys `dist/` to production with `bunx wrangler pages deploy`.

The job reads two repository secrets, set in Settings > Secrets and variables > Actions:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

A running deploy always finishes. When more merges land while one runs, only the newest waits. It deploys a `main` that holds all of them. To deploy by hand as a fallback, for example when the runner is down, run this from `main`:

```sh
cd site && bun install --frozen-lockfile && bun run build
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bunx wrangler@4.153.0 pages deploy dist --project-name materialize-3d --branch main
```
