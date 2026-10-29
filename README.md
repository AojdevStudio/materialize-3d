# Materialize 3D

Materialize 3D is a desktop app for creating 3D-printable objects through conversation. You describe what you want to the in-app assistant, the app builds and checks the print file, and you approve the exact file before it leaves the app.

The 0.2.0 source supports three-color signs and general parts, with Bambu Lab P2S 0.4 mm 3MF export. Check the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases) for distribution status and the required software acceptance record attached to a published release. See the [0.2.0 release notes](docs/releases/v0.2.0.md) for the publication gates. Physical acceptance stays pending until Ossie chooses to print and inspects the objects.

**[Published Mac releases (Apple Silicon)](https://github.com/AojdevStudio/materialize-3d/releases/latest)** · [Install guide](docs/install-macos.md) · [Acceptance checklist](docs/acceptance/p2s-test-sign.md)

## Signs and parts in 0.2.0

1. **Describe.** Ask the assistant for a sign or a functional part with dimensions and material requirements.
2. **Generate.** The app builds a face-down, three-color sign or runs generated build123d code in an isolated CAD worker for a part.
3. **Inspect.** Bambu Studio 02.08.02.61 slices with P2S 0.4 mm presets. Review geometry and slice checks. A part detail shows its rendered view, measured requirements, revision history, and print warnings.
4. **Approve.** You approve the package by its SHA-256 hash. The assistant cannot approve, and any change to the design makes a new revision that needs its own approval.
5. **Export.** You save a 3MF through the macOS Save dialog, open it in Bambu Studio, and print from there. Only you record whether the print passed.

An optional local MCP endpoint (off by default, loopback only, token protected) lets other agents build and read signs and parts with the same tools the assistant uses. They cannot approve either.

The app also contains earlier tools (model library, 3D preview, MakerWorld browser, OpenSCAD editor, print monitor, print history). Their presence does not establish 0.2.0 release acceptance. Materialize 3D does not send these approved packages to the printer. Print the exported 3MF from Bambu Studio.

## Requirements

- A Mac with Apple Silicon and macOS 26.0 or later. Intel Macs, Windows, and Linux release builds are not offered.
- [Bambu Studio 02.08.02.61](https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61), installed separately. The app never installs or bundles it.
- An Anthropic or OpenAI API key. The provider bills model usage at its own rates. The app is free.
- To print signs, a Bambu Lab P2S with a 0.4 mm nozzle, an AMS, and three filaments. Parts use the filaments specified by their design.

See [docs/install-macos.md](docs/install-macos.md) for installation, Bambu Studio setup, and uninstalling.

## How it works

The Rust backend (Tauri 2) owns every action: building signs and parts, reading revisions, approving, and exporting. Three callers use those same actions and each is recorded on the revision it touches:

- the app's own screens, the only caller that can approve or export;
- the in-app assistant, a [Rig](https://github.com/0xPlaygrounds/rig) agent running in the Rust backend;
- external agents through the local MCP endpoint.

A build writes a Bambu project package, slices it with the Bambu Studio command line, and verifies the G-code against the design before the revision can be approved. Approval binds to the package hash. If the file on disk changes, the approval is voided and export refuses to run.

## Build from source

A development build is not an installed-release acceptance test. Parts need the bundled CAD helper and pinned runtime. `bun tauri dev` alone does not package them. See the [release procedure](docs/releasing.md) and [installed GUI checklist](docs/verify-on-mac.md).

You need [Bun](https://bun.sh) 1.3, stable Rust, and on macOS the Xcode command line tools. On Linux, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Linux development builds also need a session D-Bus and an unlocked Secret Service, such as GNOME Keyring, to store API keys and printer access codes. Credential operations return an error when that service is unavailable. Builds that used kernel keyutils did not retain credentials across reboot. After upgrading from those builds, re-enter API keys and printer access codes. Saved printer configurations remain.

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

- more printers and nozzle sizes, each validated before it is offered;
- builds for Intel Macs, Windows, and Linux.

## Contributing

Issues and pull requests are welcome. Open an issue before large changes. CI uses the configured self-hosted runners. Jobs that require trusted execution skip fork and Dependabot pull requests.

## License

MIT. See [LICENSE](LICENSE). Bundled fonts and the Bambu Studio settings file keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
