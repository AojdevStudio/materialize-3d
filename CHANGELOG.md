# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-28

The first public release. The full notes are in [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

### Added

- Three-color sign workflow for the Bambu Lab P2S: describe a sign in chat, build and slice it with Bambu Studio 02.08.02.61, run 27 geometry and slice checks, approve the exact package by its SHA-256 hash, and export a 3MF through the macOS Save dialog.
- In-app assistant (Anthropic or OpenAI, with your own API key) that builds and reads signs but cannot approve them.
- Optional local MCP endpoint for other agents, off by default and loopback only, with no approval tool.
- Settings > Bambu Studio to find or choose the validated Bambu Studio.
- Signed and notarized macOS DMG for Apple Silicon.

## Links
[Unreleased]: https://github.com/AojdevStudio/materialize-3d/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AojdevStudio/materialize-3d/releases/tag/v0.1.0
