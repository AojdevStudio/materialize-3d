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

## Host facts (dev-substrate, 2026-10-05)

- The Linux host is dev-substrate (`ssh ossie@dev-substrate`, Ubuntu 24.04.5).
- `openscad` is not installed. Design renders end in `Error`, see [design](./design-openscad.md).
- Bambu Studio 02.08.02.61 is at `/home/ossie/actions-runner-materialize-3d/_work/_tool/bambu-studio/02.08.02.61/squashfs-root/AppRun`, the self-hosted runner's tool cache installed by `scripts/ci/install-bambu-linux.sh`. Export `BAMBU_STUDIO_CLI` to it before `up`, or choose it in Settings > Bambu Studio, see [signs](./signs.md).
- The CAD runtime cache is `~/.cache/m3d-tool-cache/cad-runtime/amd64-<hash>/` with `vmlinux`, `rootfs.img`, and `job.img`, see [parts](./parts.md).
- `/dev/kvm`, `/dev/vhost-vsock`, `qemu-system-x86_64`, and `keyctl` are present.
- The test P2S printer sits on a separate VLAN. Treat printer connection as unreachable unless you have confirmed the route.

## Feature entry contract

Each feature file has an H1 and one paragraph of user-visible behavior, followed by exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with wd.ts`, and `Gotchas`. Lines marked **(observed 2026-10-05)** were driven live on `f01f418`. Lines marked **(observed 2026-09-25)** were driven on `86ea7c8`, which is not an ancestor of `main`, and lines marked **(observed 2026-09-26)** in [signs](./signs.md) on `e258688`. Everything else comes from reading the code and should be confirmed on first use.

## Features

- [Onboarding](./onboarding.md) covers the four-step first-run wizard, its skip paths, and the persisted completion flag.
- [Navigation](./navigation.md) covers the sidebar, the workspace tabs, and the Library and History views.
- [Settings](./settings.md) covers the Bambu Studio location, print defaults, the agent provider, model, and API key, notifications, auto-connect, and the External agents (MCP) switch.
- [Design (OpenSCAD)](./design-openscad.md) covers opening a `.scad` file, rendering, and parameters.
- [Signs](./signs.md) covers building a sign from a spec file, reviewing a revision, hash-bound approval, export, and recording a print result.
- [Printers](./printers.md) covers adding, switching, and deleting printer configs, and connection states.
- [Chat](./chat.md) covers the always-on AI assistant panel.
- [Parts](./parts.md) covers agent-built functional parts, which have no GUI yet and are proven through the backend tests.
- [MCP](./mcp.md) covers the local MCP server for external agents, including `import_part`.
