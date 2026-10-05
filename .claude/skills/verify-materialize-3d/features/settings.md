# Settings

The Settings popover lets a user locate Bambu Studio, choose default print quality and filament, pick the agent provider and model, store an API key, toggle notifications and auto-connect, and turn on the MCP server for external agents. Every change saves immediately and survives a relaunch.

## Sub-features

- `settings-open` opens and closes the popover from the toolbar.
- `settings-bambu-studio` covers the detected copy (`bambu-studio-found`, `bambu-studio-path`), the problem and setup steps (`bambu-studio-problem`, `bambu-studio-steps`), and `bambu-studio-choose` and `bambu-studio-clear`, stored as `bambu_studio.path`.
- `settings-defaults` covers the `Quality` and `Filament` selects. Quality defaults to `0.20`.
- `settings-agent` covers the `agent-provider` and `agent-model` selects, stored as `agent.model = provider:modelId`. Changing the provider writes that provider's first model. Anthropic offers `claude-sonnet-5`, `claude-opus-5-5`, `claude-fable-5-1`, and `claude-haiku-4-5-20251001`. OpenAI offers `gpt-5.5`.
- `settings-agent-key` covers `agent-key-state`, the `agent-api-key` field, and `agent-api-key-save` and `agent-api-key-clear`. The key goes to the keyring under `api_key:<provider>`.
- `settings-notifications` covers the `Print complete`, `Print failed`, and `Filament low` checkboxes. They default to `true`.
- `settings-connection` covers the `Auto-connect on launch` checkbox. It defaults to `false`.
- `settings-mcp` covers the External agents section: `mcp-section`, `mcp-enabled`, `mcp-url`, `mcp-copy-command`, `mcp-rotate-token`, and `mcp-message`. The switch is stored as `mcp.enabled`, and the token goes to the keyring under `mcp:token`. See [mcp](./mcp.md).

## How to get to it (user POV)

- Click the gear button in the toolbar, labelled `Settings`.
- Close it with the ✕ (`Close settings`), with Escape, or by clicking outside.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.

- **Open (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label=Settings]"`, `$S/wd.ts wait "[role=dialog][aria-label=Settings]"`, and `$S/wd.ts wait "[data-testid=bambu-studio-section]" 20000`. Sections Bambu Studio, Defaults, Agent, Notifications, Connection, and External agents appear. The Bambu Studio section shows the detected version and path, or setup steps when no validated copy is found.
- **Bambu Studio (observed 2026-10-05).** Run `$S/wd.ts text "[data-testid=bambu-studio-found]"`. With the host's copy found, it reads "Bambu Studio 02.08.02.61 ✓".
- **Change quality (observed 2026-09-25).** Run `$S/wd.ts click 'xpath=//div[@role="dialog"]//label[contains(., "Quality")]//option[@value="0.16"]'` and `$S/wd.ts attr 'xpath=//div[@role="dialog"]//label[contains(., "Quality")]//select' value`. It prints `0.16`.
- **Side effect (observed 2026-09-25).** Read `select key, value from settings` from `DB`. It contains `default.quality = 0.16`.
- **Persistence.** Run `$S/wd.ts end`, `$S/wd.ts session`, reopen Settings, then run the same `attr` command. It still prints `0.16`.
- **Model (observed 2026-10-05).** Run `$S/wd.ts attr "[data-testid=agent-model]" value`. A fresh run prints `claude-sonnet-5`. Click `[data-testid=agent-model] option[value=claude-opus-5-5]`, and the same `attr` prints `claude-opus-5-5`.
- **Provider (observed 2026-10-05).** Click `[data-testid=agent-provider] option[value=openai]`. `agent-model` switches to `gpt-5.5`, and `DB` gains `agent.model = openai:gpt-5.5`. After a relaunch, `agent-provider` still reads `openai`.
- **API key (observed 2026-10-05).** Run `$S/wd.ts text "[data-testid=agent-key-state]"`. A fresh run reads "No key stored". To store a key, type it into `[data-testid=agent-api-key]` and click `[data-testid=agent-api-key-save]`. `[data-testid=agent-api-key-clear]` removes it. Saving and clearing were not driven live.
- **External agents (observed 2026-10-05).** Click `[data-testid=mcp-enabled]`. `[data-testid=mcp-url]` appears and reads `http://127.0.0.1:45373/mcp`. `DB` gains `mcp.enabled = true`, and after a relaunch `mcp-url` is still visible. See [mcp](./mcp.md) for the server itself.
- **Removed handles (observed 2026-10-05).** `$S/wd.ts count "[data-testid=agent-model-hint]"` and `$S/wd.ts count "[data-testid=settings-slicer]"` both print `0`.
- **Checkboxes.** Run `$S/wd.ts click 'xpath=//div[@role="dialog"]//label[contains(., "Filament low")]//input'`. The `notifications.filament_low` row flips.
- **Close (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label='Close settings']"` and `$S/wd.ts gone "[role=dialog][aria-label=Settings]"`.

## Gotchas

- Selects stay disabled until the profile list loads. Wait until the Quality select is enabled (`$S/wd.ts wait "[role=dialog] select:not([disabled])"`) before clicking options.
- The select text renders light-on-light and is barely readable in screenshots. Prove values with `attr ... value` and the DB, not pixels.
- The stored default filament `PLA Basic` is not one of the options, so a fresh run displays `Bambu PETG Basic`, the first option, without writing it.
- Without its own session keyring, the Agent section shows only "keyring entry error for key=api_key:anthropic: No matching entry found in secure storage", and enabling MCP fails with the same error for `mcp:token`. `m3d.sh up` prevents this by running the app under `keyctl session -`, see SKILL.md.
- The External agents hint still reads "External agents can build and read signs". That text is stale, because MCP also imports parts.
- Settings has no printer section. Printers live in the toolbar popover, see [printers](./printers.md).
