# Materialize 3D verification map

This directory is the maintained source for verifying Materialize 3D's user-facing behavior. Read this index before driving the app, then follow the matching feature file as the recipe. Commands assume `S=.agents/skills/verify-materialize-3d/scripts`, run from the checkout root on the Linux host.

For installed macOS release acceptance, use [Verify the installed Mac app](../../../../docs/verify-on-mac.md). The Linux WebDriver recipes and macOS e2e debug driver do not establish release-binary acceptance.

## Baseline preconditions

- `$S/m3d.sh up` printed `m3d: ready`, and `$S/m3d.sh doctor` exits 0.
- `$S/wd.ts session` is open, and `$S/m3d.sh close-inspector` reports a 1440x900 viewport.
- The app opens on the [studio](./studio.md) start screen. Wait for `[data-testid=start-screen]`.
- `STORE` means `$(readlink -f "${M3D_RUNS:-$HOME/m3d-verify}/current")/xdg/data/com.aojdevstudio.materialize3d/state/store.sqlite`, the sidecar's store. `m3d.sh` keeps its runs under `M3D_RUNS` when that is set.

## Driving conventions

- Prefer `data-testid`, then `aria-label`, then role and label XPath. Never use coordinates inside the webview.
- Choose a `<select>` value by clicking its `<option>`. Toggle a checkbox by clicking it.
- `wd.ts eval` inspects state only. Never set stores or call `invoke` to cause the behavior under test.
- Native GTK dialogs are answered with `$S/m3d.sh file-dialog <abs-path>`.
- Relaunch with `$S/wd.ts end` then `$S/wd.ts session` to prove anything persists.

## Proof and skip reporting

- Take a screenshot before and after each user action that matters. `actions.log` records the commands.
- Mutation proof includes the file on disk or the state after a relaunch.
- Record the feature file and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition, such as no inference login or no uv.
- Do not report a skipped entry point as verified through a different path.

## Host facts (dev-substrate, 2026-11-03)

- The Linux host is dev-substrate (`ssh ossie@dev-substrate`, Ubuntu 24.04.5). It has Bun 1.4.4, tauri-driver 2.1.0, WebKitGTK 2.52.6, and Google Chrome 156 at `/opt/google/chrome`. The app on `main` builds with Tauri 2.12.5 and wry 0.57.1.
- aojdevlinux cannot run the app harness and cannot run the site tests as installed, see SKILL.md and [site](./site.md). Drive dev-substrate from it over ssh.
- Bambu Studio 02.08.02.61 is at `/home/ossie/actions-runner-materialize-3d/_work/_tool/bambu-studio/02.08.02.61/squashfs-root/AppRun`, the self-hosted runner's tool cache installed by `scripts/ci/install-bambu-linux.sh`. Export `BAMBU_STUDIO_CLI` to it before `up` so the agent's `slice` tool finds it.
- The harness build has no `e2e` feature, so the studio keeps its projects in the host user's `~/Documents/Materialize 3D/`, not in the run directory.

## Feature entry contract

Each feature file has an H1 and one paragraph of user-visible behavior, followed by exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with wd.ts`, and `Gotchas`. A line marked **(observed <date>)** was driven live on that date. Everything else comes from reading the code and should be confirmed on first use. [Site](./site.md) keeps the same four H2s, and its driving section uses Playwright instead of `wd.ts`.

## Features

- [Studio](./studio.md) is the whole app: chat with the agent, pictures, the preview and Files panel, and Open in Bambu Studio. Its recipe starts at the start screen.
- [Updater](./updater.md) covers the update banner at launch, Later, the wait for the agent's work, and the failed check and failed install states.
- [Site](./site.md) covers the landing site's Playwright tests on Google Chrome. They do not use `wd.ts`.
