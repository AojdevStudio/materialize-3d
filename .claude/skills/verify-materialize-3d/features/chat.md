# Chat

The AI assistant panel on the right of the main UI takes a message and runs the app's Rust agent (Rig) with the selected provider and model. The agent's tools are `describe_kind`, `build`, `revise`, `get`, `list`, `show`, and `printer_status`. A build made in chat opens itself in the Signs view. Conversations persist and reload after a relaunch.

## Sub-features

- `chat-panel` is the always-mounted panel with the "AI Assistant" header, `New conversation`, starter prompts, and a `<Provider> · <model>` line.
- `chat-send` sends the text in `chat-input`. `chat-stop` stops a running turn.
- `chat-credential` shows an inline `chat-error` with an `Open Settings` control when the provider has no key.
- `chat-tools` covers tool calls in the transcript: `tool-build` (with `data-state`), `tool-steps`, and `tool-result`. A finished build fires `designs:open`, see [signs](./signs.md).
- `chat-history` covers persisted conversations in SQLite (`agent_conversations`, `agent_messages`) and `chat-new-conversation`.

## How to get to it (user POV)

- The panel is always visible at the right edge of the main UI. There is no toggle.
- Click a starter prompt, or type in the input and click Send.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- For a real response, the provider in Settings has a key stored and the host has network. dev-substrate has no provider credential, so chat with a key is unreachable there.

- **Panel present (observed 2026-10-05).** Run `$S/wd.ts text "[data-testid=chat-panel]"`. It reads "AI Assistant / New conversation / No messages yet. Ask for a part, a sign, or a printer action. / Design a door sign / Check printer status / List my recent signs / OpenAI · gpt-5.5 / Send" after the provider was set to OpenAI in Settings.
- **No key (observed 2026-10-05).** Run `$S/wd.ts click "text=Check printer status"` and `$S/wd.ts wait "[data-testid=chat-error]"`. It reads "No openai API key is saved. Add one in the agent settings. Open Settings to add a key, then retry."
- **Open Settings from the error (observed 2026-10-05).** Click the `Open Settings` control inside `chat-error`. `[role=dialog][aria-label=Settings]` opens.
- **History side effect (observed 2026-10-05).** After the failed turns, `DB` holds 1 row in `agent_conversations` and 0 rows in `agent_messages`.
- **New conversation (observed 2026-10-05).** Click `[data-testid=chat-new-conversation]`. The panel shows the empty state again.
- **Type and send.** Run `$S/wd.ts type "[data-testid=chat-input]" "<message>"` and `$S/wd.ts click "[data-testid=chat-send]"`.
- **With a key.** An assistant reply streams in. A build shows `[data-testid=tool-build]`, whose `data-state` tracks progress, plus `tool-steps` and `tool-result`. The finished build opens in the Signs view. Verify the new `revisions` row in `DB`. This path was not driven live. Do not report it as verified.

## Gotchas

- Keys come from the kernel keyring, service `com.materialize3d`, entry `api_key:<provider>`. The app reads them only because `m3d.sh up` gives it its own session keyring, see SKILL.md.
- Messages persist in `agent_messages`, and the history reloads after a relaunch.
- On the Linux app the agent never offers the `part` kind, see [parts](./parts.md).
