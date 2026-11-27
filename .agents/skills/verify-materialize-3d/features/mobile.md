# Mobile

The iPhone and iPad window (`src/mobile`) pairs with the computer, lists its chats, and opens one chat. On a phone, the chat and the 3D model are two tabs. On a tablet (both sides at least 600 px), the model sits above the chat in portrait and beside it in landscape. The composer holds the Lead and Helper role pickers. jsdom has no layout, so the Vitest tests in `src/mobile/*.test.tsx` cannot see whether any of this fits the screen. `src/mobile/layout.spec.ts` checks it in Google Chrome at real screen sizes, against the production mobile window build, with Rust and the paired computer faked inside the page.

## Sub-features

- Each test's title in `src/mobile/layout.spec.ts` names what it covers, once per size: 375x667, 390x844, 667x340 (a phone on its side), and 820x1180 (a tablet). `bunx playwright test --config playwright.mobile.config.ts --list` prints them.
- The chat list: the last of 40 chats scrolls into view with the wheel and opens with a tap. This is the #358 bug.
- The role menus: with a picture in the draft and a 16-model catalog, every option of the Lead and Helper menus sits inside the viewport once the mouse wheel scrolls the menu to it. This is the #368 bug on a phone on its side.
- The newest line: a reply that arrives while the Model tab hides the chat is in view on the way back to Chat. A tablet has no tabs, so there the reply arrives with the chat in sight. Each size says whether it is a tablet, so a phone that lost its tabs fails instead of taking the tablet path. This is the #368 bug on the small phone.

## How to get to it (user POV)

- A person opens Materialize 3D on an iPhone or iPad that is already paired. The chat list shows, and a tap opens a chat.
- For verification, the tests serve the mobile build at `http://127.0.0.1:<port>/`, on a port the system says is free. The real app loads the same build in its iOS web view.

## Driving it with wd.ts

`wd.ts` does not drive the mobile window. Playwright does, from the checkout root, with the Bun that CI pins:

```bash
bun install --frozen-lockfile
bun run test:mobile-layout
```

Preconditions:

- Google Chrome at its standard location: `/opt/google/chrome/chrome` on Linux, `/Applications/Google Chrome.app` on macOS. `channel: 'chrome'` in `playwright.mobile.config.ts` looks only there.
- No fixed port. The config takes a free one and passes it to its workers in `M3D_MOBILE_PORT`, so runs in two worktrees do not collide.

- **aojdevlinux (observed 2026-11-27).** With Bun 1.4.4 and Google Chrome 156, all 12 tests pass in about 1 minute, build included. Run it with `TMPDIR=/tmp`, because Chrome fails with "Socket path too long" under a deep `TMPDIR`.
- **CI.** The `Mobile app checks` job runs it on dev-substrate, after the mobile window build, see `.github/workflows/ci.yml`.
- **On a device or simulator.** These tests use Chrome, not the iOS web view, and they fake the safe-area insets as 0. The Dynamic Island cutout and the real WebKit layout need the simulator proof on a Mac: `scripts/mobile/layout-proof.sh`, whose header says how to run it.

## Gotchas

- The tests run `bun run build:mobile` themselves through Playwright's `webServer`, so a stale `dist-mobile/` does not matter.
- `fakeDevice` in the spec stands in for Rust (`window.__TAURI_INTERNALS__`) and for the computer (`fetch` of `m3dremote://`). It answers reads only. A Tauri command or a computer route the window starts to call fails the test until the fake learns it.
- A locator's own `tap` or `click`, and any `scrollTop` or `scrollIntoView` from a script, can scroll a box the page clips or a person cannot scroll, and hide a layout bug. The spec scrolls only with the mouse wheel (`scrollToTouch`), checks a target with `onScreen`, and taps it in place with `tapInPlace`. Keep new checks to that pattern.
- To prove a new check has teeth, put the old bug back on a scratch commit and watch it fail. On 2026-11-27, removing `overflow-y: auto` from `.mobile-chats` failed the chat list test at all four sizes. Removing the `.mobile .model-menu` cap failed the menu test at 375x667 and 667x340. Removing the scroll on the way back to Chat in `ChatScreen.tsx` failed the newest-line test at the three phone sizes.
- `test-results/` is ignored, so a run leaves the tree clean.
