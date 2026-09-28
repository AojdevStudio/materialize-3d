# Chat

The AI assistant panel on the right of the main UI takes a message and runs the Pi agent with the selected provider and model. The agent can call app tools, such as creating OpenSCAD files, navigating, and slicing.

## Sub-features

- `chat-panel` is the always-mounted panel with the "AI Assistant" header and a provider badge.
- `chat-send` sends a message with Enter or the send button.
- `chat-credential` shows the "API Key Required" dialog when the provider has no key.
- `chat-tools` covers agent tool calls that change the app, such as `create-scad` and `navigate-to`.

## How to get to it (user POV)

- The panel is always visible at the right edge of the main UI. There is no toggle.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- For a real response, the provider in Settings has a credential and the host has network.

- **Panel present (observed 2026-09-25).** Run `$S/wd.ts wait "aside[aria-label='AI assistant panel']"`. The header reads "AI Assistant" with an `Anthropic` badge.
- **Type and send.** Run `$S/wd.ts type ".pi-chat-container message-editor textarea" "Make a 20 mm calibration cube"` and then `$S/wd.ts keys $''`. The message appears in the transcript.
- **No credential.** With no key stored, sending opens `api-key-prompt-dialog` ("API Key Required"). This is the expected end state on a fresh run.
- **With credential.** An assistant reply streams in. If the agent calls `create-scad`, the Design tab opens a file from `<data>/designs/`. Verify that file on disk as the side effect.

## Gotchas

- Only panel presence was observed live. On `86ea7c8` with no credential stored, the panel body rendered empty in every run, with no visible message input. Check `$S/wd.ts count ".pi-chat-container message-editor textarea"` before assuming the input exists. If the count is 0, report the panel as not mounted instead of driving around it.
- Messages are not persisted. A relaunch starts an empty conversation.
- Credentials come from the host user's kernel keyring (`oauth:<provider>`) and then from IndexedDB inside the run's data dir. The keyring part is shared across runs.
- Model changes from Settings apply on the next agent turn, not mid-stream.
