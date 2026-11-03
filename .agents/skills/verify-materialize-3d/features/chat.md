# Chat

The AI assistant panel on the right of the main UI takes a message and runs the app's Rust agent (Rig) with the selected provider and model. The agent's tools are `describe_kind`, `build`, `revise`, `get`, `list`, `show`, and `printer_status`. A build made in chat opens itself in the Signs view. Conversations persist and reload after a relaunch. A provider error shows the provider's own text with the API key replaced by `[API key]`, and the app follows no redirect from a provider (PR 100).

## Sub-features

- `chat-panel` is the always-mounted panel with the "AI Assistant" header, `New conversation`, starter prompts, and a `<Provider> · <model>` line, followed by ` · <server address>` when one is saved, and an activity word such as `idle`, with `, no API key` when none is stored.
- `chat-redaction` covers provider errors. `chat-error` keeps the provider's status and body, with the key replaced by `[API key]` in plain, percent-encoded, base64, and URL-safe base64 form. Each failed turn writes one line to the app log, `agent turn failed: kind=Provider provider=<p> http_status=<n>`, with no body and no key.
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
- For a real response, the provider in Settings has a key stored and the host has network. dev-substrate has no direct provider key. Ossie's CLIProxyAPI gateway answers from dev-substrate. The `claudex` config in `~/.config/claudex/` on Ossie's Linux workstation names the gateway address and its key file. Save both in onboarding or Settings, typing the key with `wd.ts type-secret`. Keep both out of tracked files and evidence, and paint the gateway host over in screenshots.
- For the redaction check, no real key or network: a fake provider on loopback that answers every request with an error body echoing the request's key. Port 18765 must be free.

- **Panel present (observed 2026-11-03).** With OpenAI and no key, the panel ends "OpenAI · GPT-6 Astra / idle, no API key / Send".
- **Panel present (observed 2026-10-05, footer 2026-10-06).** Run `$S/wd.ts text "[data-testid=chat-panel]"`. It reads "AI Assistant / New conversation / No messages yet. Ask for a part, a sign, or a printer action. / Design a door sign / Check printer status / List my recent signs / OpenAI · GPT-6 Astra / Send" after the provider was set to OpenAI in Settings.
- **No key (observed 2026-10-05).** Run `$S/wd.ts click "text=Check printer status"` and `$S/wd.ts wait "[data-testid=chat-error]"`. It reads "No openai API key is saved. Add one in the agent settings. Open Settings to add a key, then retry."
- **Open Settings from the error (observed 2026-10-05).** Click the `Open Settings` control inside `chat-error`. `[role=dialog][aria-label=Settings]` opens.
- **History side effect (observed 2026-10-05, again 2026-11-03).** After the missing-key refusals, `DB` holds 1 row in `agent_conversations` and 0 rows in `agent_messages`. A turn that reaches a provider stores the user's message first, so after four provider errors `DB` held 5 conversations and 4 messages.
- **New conversation (observed 2026-10-05).** Click `[data-testid=chat-new-conversation]`. The panel shows the empty state again.
- **Type and send.** Run `$S/wd.ts type "[data-testid=chat-input]" "<message>"` and `$S/wd.ts click "[data-testid=chat-send]"`.
- **Installed 0.2.0 OpenAI acceptance.** Follow [Verify the installed Mac app](../../../../docs/verify-on-mac.md) for sign and part prompts, GUI review, approval, export hashes, and Bambu Studio P2S 0.4 mm import. This run remains pending. A debug or MCP build does not replace it.
- **With a key, through the gateway (observed 2026-11-01).** With the gateway address and key saved for Anthropic and the model ID `claude-sonnet-5-5`, send "Make a 150 x 210 mm door sign that says BACK SHORTLY in navy on white with a teal rule under it". The reply streams in, `[data-testid=tool-build]` reaches `data-state` `done`, and the Signs view opens r2 with 27 of 27 checks passed. A direct provider key was not driven.
- **Address cleared (observed 2026-11-01).** Clear the address and send a message with the gateway key still stored. `chat-error` reads "CompletionError: ProviderResponseError: status 401 Unauthorized" with Anthropic's "invalid x-api-key", so the request reached the provider's own server.
- **Provider error hides the key (observed 2026-11-03).** Start a bun server on `127.0.0.1:18765` that answers every request with status 404 (or 307 with `Location` set to a `/capture` path that counts hits) and the body `model unavailable raw=<k> pct=<encodeURIComponent(k)> b64=<base64(k)> url=<base64url(k)>`, where `k` is the request's `x-api-key` or bearer token. It must never print headers. Export a throwaway key with characters that encode differently, for example `export KEY=$(bun -e 'process.stdout.write(crypto.randomUUID()+"%41=+/???")')`. `type-secret` reads the environment, so the key must be exported. For each provider, in Settings: `$S/wd.ts type-secret "[data-testid=agent-api-key]" KEY --clear`, save, set `agent-base-url` to `http://127.0.0.1:18765/echo/v1` (or `/redirect/v1`), save, close Settings, click `chat-new-conversation`, and send "Check printer status". `chat-error` reads "CompletionError: ProviderResponseError: status 404 Not Found: model unavailable raw=[API key] pct=[API key] b64=[API key] url=[API key]", or the same after "status 307 Temporary Redirect:". No `Open Settings` control appears. Across Anthropic and OpenAI, echo and redirect, the fake server counted 4 requests and 0 redirect follows. `grep -cF "$KEY"` printed 0 for the app log, `logs/driver.log`, and `actions.log`.
- **Wrong address (observed 2026-11-01).** Save `http://127.0.0.1:9/v1` and send a message. `chat-error` reads "CompletionError: ProviderError: Http client error: error sending request for url (http://127.0.0.1:9/v1/messages)".

## Gotchas

- Keys come from the Secret Service, service `com.materialize3d`, entry `api_key:<provider>`. `m3d.sh up` gives each run its own Secret Service on a private D-Bus session, see SKILL.md.
- The app log is `<run>/xdg/data/com.aojdevstudio.materialize3d/logs/Materialize 3D.log`. The log plugin keeps one file of at most 40 KB (its defaults, `KeepOne` and 40000 bytes), and a debug build logs TRACE lines, so older lines roll out within seconds. Read the `agent turn failed` line right after each turn. After four turns only the last one was still there **(observed 2026-11-03)**. The failure line does not reach `logs/driver.log`. `down` deletes `xdg/`, so copy the log first.
- Messages persist in `agent_messages`, and the history reloads after a relaunch.
- On the Linux app the agent never offers the `part` kind, see [parts](./parts.md).
