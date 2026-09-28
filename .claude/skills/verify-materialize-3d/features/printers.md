# Printers

The printer badge in the toolbar opens a printer selector, where a user adds Bambu printers by host, serial, and access code, switches between them, and deletes them. The badge and status bar reflect the connection state.

## Sub-features

- `printers-open` opens the selector from the toolbar badge.
- `printers-add` covers the add form with required-field validation.
- `printers-switch` switches to a config, which starts a connection attempt.
- `printers-delete` removes a config.
- `printers-status` covers the badge label (`Offline`, `Connecting…`, `Reconnecting`, `MQTT`, `CLOUD`) and the status bar text.

## How to get to it (user POV)

- Click the toolbar badge labelled `printer connection status`, which reads "No Printer · OFFLINE" on a fresh run.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- Use a TEST-NET address such as `192.0.2.10`, never the real printer's host, serial, or access code. Any credentials go into the host keyring.

- **Open.** Run `$S/wd.ts click "button[aria-label='printer connection status']"` and `$S/wd.ts wait "[role=dialog][aria-label='Printer selector']"`. A fresh run shows "No printers configured" and `+ Add your first printer`.
- **Validation.** Click `text=+ Add your first printer`, then `button.printer-selector-submit` with the fields empty. `[role=alert]` reads "All fields are required".
- **Add.** Fill `input[placeholder='My Bambu P1S']`, `input[placeholder='192.0.2.136']`, `input[placeholder='01P00A000000000']`, and `input[type=password]` with `$S/wd.ts type`, then click `button.printer-selector-submit`. The list shows the new name, and `DB` gains a `printer_configs` row. Adding does not connect.
- **Switch.** Click `button[aria-label='Switch to <name>']`. The badge goes through `Connecting…` and then `Reconnecting`. `[role=alert][aria-label='Connection error']` appears with `button[aria-label=Disconnect]`, and later `button[aria-label='Retry connection']`.
- **Delete.** Click `button[aria-label='Delete <name>']`. The row disappears from the list and from `printer_configs`.

## Gotchas

- Nothing in this file was driven live yet. Confirm the handles on first use and mark them observed.
- Access codes go to the OS keyring through the `keyring` crate's `linux-native` backend (kernel keyutils). That keyring belongs to the host user and is not isolated per run. Delete test configs before `down`.
- A successful connection, telemetry, and the `MQTT`/`CLOUD` badge need the real P2S. It sits on a separate VLAN, and the Linux host has no confirmed route to it.
- The onboarding printer form is a different, currently broken path, see [onboarding](./onboarding.md).
