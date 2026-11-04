# Settings

The Settings popover lets a user locate Bambu Studio, choose default print quality and filament, pick the agent provider and model, store an API key, toggle notifications and auto-connect, turn on the MCP server for external agents, and see the installed version with a manual update check. Selects and checkboxes save on change. An API key, a server address, and a typed model ID save only with their Save button. Every saved value survives a relaunch.

## Sub-features

- `settings-open` opens and closes the popover from the toolbar.
- `settings-bambu-studio` covers the detected copy (`bambu-studio-found`, `bambu-studio-path`), the problem and setup steps (`bambu-studio-problem`, `bambu-studio-steps`), and `bambu-studio-choose` and `bambu-studio-clear`, stored as `bambu_studio.path`.
- `settings-defaults` covers the `Quality` and `Filament` selects. Quality defaults to `0.20`.
- `settings-agent` covers the `agent-provider` and `agent-model` selects, stored as `agent.model = provider:modelId`. Changing the provider writes that provider's default, the first model in its list. The Rust agent owns the lists (`models` in `src-tauri/src/agent/commands.rs`) and sends the active provider's list as `status.models`. Anthropic offers `claude-opus-5-5` and `claude-fable-5-1`. OpenAI offers `gpt-6-astra` and `gpt-6.1-sol`. A stored model that is not offered reads as the provider's default, unless the provider has a server address saved.
- `settings-agent-key` covers `agent-key-state`, the `agent-api-key` field, and `agent-api-key-save` and `agent-api-key-clear`. The key goes to the keyring under `api_key:<provider>`. A provider switch empties an unsaved key, so Save cannot store it for the next provider. A model change keeps it.
- `settings-agent-server` covers the `agent-base-url` field with `agent-base-url-save` and `agent-base-url-clear`, stored as `agent.base_url:<provider>` with outer spaces trimmed. Only `https://`, or `http://` to a loopback or private address, is saved, and never with a user name, password, query, or fragment. A provider switch empties unsaved address and model ID drafts. An empty address means the provider's own server. While an address is saved, `agent-model-id` and `agent-model-id-save` take any model ID, and the `agent-model` select also lists it. Clearing the address returns the provider in use to its default model.
- `settings-notifications` covers the `Print complete`, `Print failed`, and `Filament low` checkboxes. They default to `true`.
- `settings-connection` covers the `Auto-connect on launch` checkbox. It defaults to `false`.
- `settings-about` covers the About section: `about-section`, `about-version`, `about-check`, `about-update-now`, and `about-status`. It is the last section. See [updater](./updater.md) for the recipe.
- `settings-mcp` covers the External agents section: `mcp-section`, `mcp-enabled`, `mcp-url`, `mcp-copy-command`, `mcp-rotate-token`, and `mcp-message`. The switch is stored as `mcp.enabled`, and the token goes to the keyring under `mcp:token`. See [mcp](./mcp.md).

## How to get to it (user POV)

- Click the gear button in the toolbar, labelled `Settings`.
- Close it with the ✕ (`Close settings`), with Escape, or by clicking outside.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.

- **Open (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label=Settings]"`, `$S/wd.ts wait "[role=dialog][aria-label=Settings]"`, and `$S/wd.ts wait "[data-testid=bambu-studio-section]" 20000`. Sections Bambu Studio, Defaults, Agent, Notifications, Connection, and External agents appear. About follows them since PR 78 **(observed 2026-11-01)**. The Bambu Studio section shows the detected version and path, or setup steps when no validated copy is found.
- **Bambu Studio (observed 2026-10-05).** Run `$S/wd.ts text "[data-testid=bambu-studio-found]"`. With the host's copy found, it reads "Bambu Studio 02.08.02.61 ✓".
- **Change quality (observed 2026-09-25).** Run `$S/wd.ts click 'xpath=//div[@role="dialog"]//label[contains(., "Quality")]//option[@value="0.16"]'` and `$S/wd.ts attr 'xpath=//div[@role="dialog"]//label[contains(., "Quality")]//select' value`. It prints `0.16`.
- **Side effect (observed 2026-09-25).** Read `select key, value from settings` from `DB`. It contains `default.quality = 0.16`.
- **Persistence.** Run `$S/wd.ts end`, `$S/wd.ts session`, reopen Settings, then run the same `attr` command. It still prints `0.16`.
- **Model (observed 2026-10-06).** Run `$S/wd.ts attr "[data-testid=agent-model]" value`. A fresh run prints `claude-opus-5-5`, and the options read "Opus 5.5" and "Fable 5.1". Click `[data-testid=agent-model] option[value=claude-fable-5-1]`, and the same `attr` prints `claude-fable-5-1`. `DB` holds `agent.model = anthropic:claude-fable-5-1`.
- **Provider (observed 2026-10-06).** Click `[data-testid=agent-provider] option[value=openai]`. `agent-model` switches to `gpt-6-astra`, its options read "GPT-6 Astra" and "GPT-6.1 Sol", and `DB` gains `agent.model = openai:gpt-6-astra`. After a relaunch, `agent-provider` still reads `openai`.
- **Retired model (observed 2026-10-06).** End the session, set `agent.model` to `anthropic:claude-sonnet-5` in `DB`, and relaunch. The chat footer reads "Anthropic · Opus 5.5", and `agent-model` prints `claude-opus-5-5`. The stored row is not rewritten.
- **API key (observed 2026-11-03).** Run `$S/wd.ts text "[data-testid=agent-key-state]"`. A fresh run reads "No key stored". Run `KEY=sk-test-dummy-0000 $S/wd.ts type-secret "[data-testid=agent-api-key]" KEY --clear` and click `[data-testid=agent-api-key-save]`. `agent-key-state` reads "Key stored", also after a relaunch, which proves the run's Secret Service kept it. `[data-testid=agent-api-key-clear]` returns it to "No key stored".
- **Key draft on a model change (observed 2026-11-03).** Type a draft, then click another `agent-model` option. The field keeps the draft (length 18).
- **Key draft on a provider switch (observed 2026-11-02).** On a fresh run, type `sk-test-dummy-0000` into `agent-api-key`, then click `[data-testid=agent-provider] option[value=openai]`. `$S/wd.ts attr "[data-testid=agent-api-key]" value` prints an empty line, `$S/wd.ts attr "[data-testid=agent-api-key-save]" disabled` prints `true`, and `agent-key-state` still reads "No key stored". Before the fix for issue 91, the field kept the draft and Save stored it as the OpenAI key.
- **Address trimmed, model typed, query refused (observed 2026-11-03).** With OpenAI selected, type `  https://gateway.example/v1  ` into `agent-base-url` and click `agent-base-url-save`. `agent-model-id` appears, and `$S/wd.ts attr "[data-testid=agent-base-url]" value` prints `https://gateway.example/v1`. Type `gpt-6-custom` into `agent-model-id` and click `agent-model-id-save`. `DB` holds `agent.base_url:openai = https://gateway.example/v1` and `agent.model = openai:gpt-6-custom`, and both survive a relaunch. `agent-base-url-clear` returns `agent-model` to `gpt-6-astra`. Saving `https://gateway.example/v1?mode=test` shows the alert "the server address cannot hold a user name, password, query, or fragment".
- **Server address and typed model (observed 2026-11-01).** With an address saved in onboarding, the Agent section shows it in `agent-base-url` and shows `agent-model-id`. Type `claude-sonnet-5-5` into `agent-model-id` and click `agent-model-id-save`. `agent-model` prints `claude-sonnet-5-5` and reads "Sonnet 5.5", also after a relaunch. Click `agent-base-url-clear`. `agent-model-id` disappears and `agent-model` prints `claude-opus-5-5`. Type `http://gateway.example/v1` and save. The section's alert reads "the server address must start with https://, or http:// for a loopback or private address", and nothing is stored.
- **External agents (observed 2026-10-05).** Click `[data-testid=mcp-enabled]`. `[data-testid=mcp-url]` appears and reads `http://127.0.0.1:45373/mcp`. `DB` gains `mcp.enabled = true`, and after a relaunch `mcp-url` is still visible. See [mcp](./mcp.md) for the server itself.
- **Removed handles (observed 2026-10-05).** `$S/wd.ts count "[data-testid=agent-model-hint]"` and `$S/wd.ts count "[data-testid=settings-slicer]"` both print `0`.
- **Checkboxes.** Run `$S/wd.ts click 'xpath=//div[@role="dialog"]//label[contains(., "Filament low")]//input'`. The `notifications.filament_low` row flips.
- **Contrast (observed 2026-10-07).** Open Settings and run `$S/wd.ts contrast "[role=dialog][aria-label=Settings] :is(select, input:not([type=checkbox]))"`. The four selects read 15.13 on `#111114` and the command exits 0. Before the fix they read 1.13 on the native `#f4f4f4` box and it exited 1.
- **Close (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label='Close settings']"` and `$S/wd.ts gone "[role=dialog][aria-label=Settings]"`.

## Gotchas

- The Quality and Filament selects stay disabled until the profile list loads. Wait until one is enabled (`$S/wd.ts wait "[role=dialog] select:not([disabled])"`) before clicking options. Provider and Model are disabled only while a change is saving.
- Prove select values with `attr ... value` and the DB, not pixels.
- The stored default filament `PLA Basic` is not one of the options, so a fresh run displays `Bambu PETG Basic`, the first option, without writing it.
- On Linux the app keeps keys in the Secret Service (`keyring` with `sync-secret-service` in `src-tauri/Cargo.toml`, since PR 55). `m3d.sh up` gives each run a private D-Bus session with its own unlocked collection, so a stored key survives a relaunch inside the run, and `down` deletes it. A missing key reads "No key stored".
- The External agents hint names what MCP tools can do, import parts included, and what stays with the person **(observed 2026-11-04)**. See [mcp](./mcp.md) for the exact text.
- About sits below External agents. Run `$S/wd.ts hover "[data-testid=about-section]"` to scroll it into view before a screenshot.
- Settings has no printer section. Printers live in the toolbar popover, see [printers](./printers.md).
