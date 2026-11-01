# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Mac app checks for a newer release at launch and offers **Update now** or **Later**. Update now downloads the update, checks its signature, backs up the database and print queue, installs, and restarts. Later asks again at the next launch. **Settings > About** shows the installed version and checks on request (#72).
- The release build signs an update archive of the notarized app and writes `latest.json`, the feed installed apps read from the latest GitHub release (#72).

## [0.2.1] - 2026-10-30

A printer certificate check, security updates, and bug fixes. No new features. The full notes are in [docs/releases/v0.2.1.md](docs/releases/v0.2.1.md).

### Security

- Local printer connections check the printer's TLS certificate against Bambu's printer roots and the printer's serial number. Before, any device on the network could pose as the printer and receive the access code (#66). File upload over FTPS still accepts any certificate (#65).
- `zip` 9.1.3 replaces 2.4.2. It fixes a critical advisory where a crafted archive shows different contents to different readers, plus two more. Sign packages keep the same bytes.
- `rumqttc` 0.25.1 moves printer connections from `rustls` 0.22.4 to `rustls` 0.23.46, which also fixes four `rustls` advisories.
- The bundled CAD runtime moves to Pillow 13.0.0, which fixes 41 advisories, and certifi 2026.10.23, which stops trusting an emSign root whose intermediate keys were compromised.
- Vitest 4.1.12 replaces 3.2.4 for development. The app does not include it.

### Fixed

- First-run printer setup saves the values you enter.
- Print history shows saved prints after a restart, shows the Success badge, and shows an error when it cannot load.
- The app no longer crashes at launch when auto-connect is on and a default printer is saved.
- The Rust tests no longer overwrite the real print queue file.

### Changed

- Linux source builds store credentials in the Secret Service, so they survive a reboot. They need a session D-Bus and an unlocked Secret Service provider. After you update, enter API keys and printer access codes again, and give connected agents the new MCP token.

## [0.2.0] - 2026-10-24

Adds general parts to the signs workflow. The full notes are in [docs/releases/v0.2.0.md](docs/releases/v0.2.0.md).

### Added

- General parts written as build123d code, built in an isolated CAD worker, then inspected and measured.
- A part detail in the Signs view with a rendered view, revision history, measured requirements, checks, and print warnings.
- A bundled CAD helper and pinned CAD runtime in the macOS app.

## [0.1.0] - 2026-09-28

The first public release. The full notes are in [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

### Added

- Three-color sign workflow for the Bambu Lab P2S: describe a sign in chat, build and slice it with Bambu Studio 02.08.02.61, run 27 geometry and slice checks, approve the exact package by its SHA-256 hash, and export a 3MF through the macOS Save dialog.
- In-app assistant (Anthropic or OpenAI, with your own API key) that builds and reads signs but cannot approve them.
- Optional local MCP endpoint for other agents, off by default and loopback only, with no approval tool.
- Settings > Bambu Studio to find or choose the validated Bambu Studio.
- Signed and notarized macOS DMG for Apple Silicon.

### Security

- Tauri 2.11.6, which fixes an origin confusion that let remote pages invoke local-only IPC commands (GHSA-7gmj-67g7-phm9), and patched openssl, quinn-proto, rustls-webpki, serde_with, and rand.

## Links
[Unreleased]: https://github.com/AojdevStudio/materialize-3d/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/AojdevStudio/materialize-3d/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AojdevStudio/materialize-3d/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AojdevStudio/materialize-3d/releases/tag/v0.1.0
