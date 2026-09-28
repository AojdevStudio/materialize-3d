# Materialize 3D verification map

This directory is the maintained source for verifying Materialize 3D's user-facing behavior. Read this index before driving the app, then follow the matching feature file as the recipe. Commands assume `S=.claude/skills/verify-materialize-3d/scripts`, run from the checkout root on the Linux host.

## Baseline preconditions

- `$S/m3d.sh up` printed `m3d: ready`, and `$S/m3d.sh doctor` exits 0.
- `$S/wd.ts session` is open, and `$S/m3d.sh close-inspector` reports a 1440x900 viewport.
- A fresh run starts at onboarding. Every recipe except [onboarding](./onboarding.md) starts from the main UI, so complete onboarding first: `$S/wd.ts click "[data-testid=btn-get-started]"`, `$S/wd.ts click "[data-testid=btn-llm-skip]"`, `$S/wd.ts click "[data-testid=btn-bambu-skip]"`, `$S/wd.ts click "[data-testid=btn-launch-app]"`, `$S/wd.ts wait "nav[aria-label=Primary]"`.
- `DB` means `$(readlink -f ~/m3d-verify/current)/xdg/data/com.aojdevstudio.materialize3d/materialize.db`. Read it with the bun one-liner in SKILL.md.

## Driving conventions

- Prefer `data-testid`, then `aria-label`, then role and label XPath. Never use coordinates inside the webview.
- Choose a `<select>` value by clicking its `<option>`. Toggle a checkbox by clicking it.
- `wd.ts eval` inspects state only. Never set stores or call `invoke` to cause the behavior under test.
- Native GTK dialogs are answered with `$S/m3d.sh file-dialog <abs-path>`.
- Relaunch with `$S/wd.ts end` then `$S/wd.ts session` to prove anything persists.

## Proof and skip reporting

- Take a screenshot before and after each user action that matters. `actions.log` records the commands.
- Mutation proof includes the SQLite row or the file on disk, plus the state after a relaunch.
- Record the feature file and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition: no `openscad`, no provider credential, no printer on the network.
- Do not report a skipped entry point as verified through a different path.

## Host facts (the Linux host, 2026-09-25)

- `openscad` is not installed. Design renders end in `Error`, see [design](./design-openscad.md).
- OrcaSlicer is not installed at any path the app checks. Settings still shows `OrcaSlicer ✓`, because the check reads static profiles.
- The test P2S printer sits on a separate VLAN. Treat printer connection as unreachable unless you have confirmed the route.

## Feature entry contract

Each feature file has an H1 and one paragraph of user-visible behavior, followed by exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with wd.ts`, and `Gotchas`. Lines marked **(observed 2026-09-25)** were driven live on `86ea7c8`. Everything else comes from reading the code and should be confirmed on first use.

## Features

- [Onboarding](./onboarding.md) covers the four-step first-run wizard, its skip paths, and the persisted completion flag.
- [Navigation](./navigation.md) covers the sidebar, the workspace tabs, and the Library and History views.
- [Settings](./settings.md) covers print defaults, the agent provider and model, notifications, auto-connect, and the slicer indicator.
- [Design (OpenSCAD)](./design-openscad.md) covers opening a `.scad` file, rendering, and parameters.
- [Printers](./printers.md) covers adding, switching, and deleting printer configs, and connection states.
- [Chat](./chat.md) covers the always-on AI assistant panel.
