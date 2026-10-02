# Materialize 3D

Materialize 3D is a desktop app for creating 3D-printable objects through conversation. You describe what you want to the in-app assistant, the app builds and checks the print file, and you approve the exact file before it leaves the app.

Version 0.1.0 does one thing end to end: **three-color signs for the Bambu Lab P2S.** Signs are the first proven workflow, not the limit of the project.

**[Download for Mac (Apple Silicon)](https://github.com/AojdevStudio/materialize-3d/releases/latest)** · [Install guide](docs/install-macos.md) · [Acceptance checklist](docs/acceptance/p2s-test-sign.md)

## What works in 0.1.0

1. **Describe.** Ask the assistant for a sign, such as "an 80 x 50 mm sign that says HELLO in navy on a white base".
2. **Generate.** The app builds a face-down, three-color sign: a white base with two inlay colors.
3. **Inspect.** Bambu Studio slices it with P2S 0.4 mm presets, and the app runs 27 automated geometry and slice checks, including first-layer coverage for each color.
4. **Approve.** You approve the package by its SHA-256 hash. The assistant cannot approve, and any change to the design makes a new revision that needs its own approval.
5. **Export.** You save a 3MF through the macOS Save dialog, open it in Bambu Studio, and print from there. Only you record whether the print passed.

An optional local MCP endpoint (off by default, loopback only, token protected) lets other agents build and read signs with the same tools the assistant uses. They cannot approve either.

The app also contains earlier tools (model library, 3D preview, MakerWorld browser, OpenSCAD editor, print monitor, print history). They are not part of the validated workflow in 0.1.0.

## Requirements

- A Mac with Apple Silicon. Tested on macOS 26.7. Intel Macs, Windows, and Linux builds are not offered.
- [Bambu Studio 02.08.02.61](https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61), installed separately. The app never installs or bundles it.
- An Anthropic or OpenAI API key. The provider bills model usage at its own rates. The app is free.
- To print: a Bambu Lab P2S with an AMS and three filaments.

See [docs/install-macos.md](docs/install-macos.md) for installation, Bambu Studio setup, and uninstalling.

## How it works

The Rust backend (Tauri 2) owns every action: building a sign, reading revisions, approving, exporting. Three callers use those same actions and each is recorded on the revision it touches:

- the app's own screens, the only caller that can approve or export;
- the in-app assistant, a [Rig](https://github.com/0xPlaygrounds/rig) agent running in the Rust backend;
- external agents through the local MCP endpoint.

A sign build writes a Bambu project package, slices it with the Bambu Studio command line, and verifies the G-code against the design before the revision can be approved. Approval binds to the package hash. If the file on disk changes, the approval is voided and export refuses to run.

## Build from source

You need [Bun](https://bun.sh) 1.3, stable Rust, and on macOS the Xcode command line tools. On Linux, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
bun install
bun tauri dev
```

Run the checks that CI runs:

```bash
bunx tsc --noEmit
bun run test
(cd src-tauri && cargo test --lib --locked)
```

Tests that slice with a real Bambu Studio are ignored by default. Point `BAMBU_STUDIO_CLI` at a 02.08.02.61 executable and run `cargo test --lib --locked fabrication::pipeline -- --ignored`.

## Roadmap

These are directions, not commitments or dates:

- more kinds of printable objects beyond signs, created the same way: describe, generate, inspect, approve, export;
- more printers and nozzle sizes, each validated before it is offered;
- builds for Intel Macs, Windows, and Linux.

## Contributing

Issues and pull requests are welcome. Open an issue before large changes. CI runs on GitHub-hosted runners, and workflows from forks wait for a maintainer's approval before they run.

## License

MIT. See [LICENSE](LICENSE). Bundled fonts and the Bambu Studio settings file keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
