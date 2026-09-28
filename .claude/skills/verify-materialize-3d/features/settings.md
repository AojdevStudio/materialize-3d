# Settings

The Settings popover lets a user choose default print quality and filament, pick the agent provider and model, toggle notifications and auto-connect, and see whether the slicer is available. Every change saves immediately and survives a relaunch.

## Sub-features

- `settings-open` opens and closes the popover from the toolbar.
- `settings-defaults` covers the `Quality` and `Filament` selects.
- `settings-agent` covers the `Provider` and `Model` selects, stored as `agent.model = provider:modelId`.
- `settings-notifications` covers the `Print complete`, `Print failed`, and `Filament low` checkboxes.
- `settings-connection` covers the `Auto-connect on launch` checkbox.
- `settings-slicer` covers the slicer status line.

## How to get to it (user POV)

- Click the gear button in the toolbar, labelled `Settings`.
- Close it with the ✕ (`Close settings`), with Escape, or by clicking outside.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.

- **Open (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label=Settings]"`, `$S/wd.ts wait "[role=dialog][aria-label=Settings]"`, and `$S/wd.ts wait "[data-testid=slicer-ok]" 20000`. Sections Defaults, Agent, Notifications, Connection, and Slicer appear, and the slicer line reads "OrcaSlicer ✓".
- **Change quality (observed 2026-09-25).** Run `$S/wd.ts click 'xpath=//div[@role="dialog"]//label[contains(., "Quality")]//option[@value="0.16"]'` and `$S/wd.ts attr 'xpath=//div[@role="dialog"]//label[contains(., "Quality")]//select' value`. It prints `0.16`.
- **Side effect (observed 2026-09-25).** Read `select key, value from settings` from `DB`. It contains `default.quality = 0.16`.
- **Persistence.** Run `$S/wd.ts end`, `$S/wd.ts session`, reopen Settings, then run the same `attr` command. It still prints `0.16`.
- **Provider and model.** Click an option under `xpath=//div[@role="dialog"]//label[contains(., "Provider")]//select`, then one under `Model`. `DB` gains `agent.model = <provider>:<modelId>`, and `[data-testid=agent-model-hint]` stays visible.
- **Checkboxes.** Run `$S/wd.ts click 'xpath=//div[@role="dialog"]//label[contains(., "Filament low")]//input'`. The `notifications.filament_low` row flips.
- **Close (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label='Close settings']"` and `$S/wd.ts gone "[role=dialog][aria-label=Settings]"`.

## Gotchas

- Selects stay disabled until the profile list loads. Wait for `slicer-ok` before clicking options.
- The select text renders light-on-light and is barely readable in screenshots. Prove values with `attr ... value` and the DB, not pixels.
- The stored default filament `PLA Basic` is not one of the options, so a fresh run displays `Bambu PETG Basic`, the first option, without writing it.
- `OrcaSlicer ✓` is shown even when OrcaSlicer is not installed, as on the Linux host. It proves nothing about slicing.
- Settings has no printer section. Printers live in the toolbar popover, see [printers](./printers.md).
