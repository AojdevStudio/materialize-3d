# Printers

The printer badge in the toolbar opens a printer selector, where a user adds Bambu printers by host, serial, and access code, switches between them, and deletes them. The badge and status bar reflect the connection state.

## Sub-features

- `printers-open` opens the selector from the toolbar badge.
- `printers-add` covers the add form with required-field validation. Adding selects the new printer in the UI, but that selection is not persisted.
- `printers-switch` switches to a config, which starts a connection attempt.
- `printers-delete` removes a config. Its Delete button shows only while the row is hovered.
- `printers-status` covers the badge label (`Offline`, `Connecting…`, `Reconnecting`, `MQTT`, `CLOUD`) and the status bar text. The badge is three spans (name, label, ▾), and CSS upper-cases the label. The status bar `.status-online` reads `Offline · <printer>`.

## How to get to it (user POV)

- Click the toolbar badge labelled `printer connection status`. On a fresh run it shows "No Printer", "OFFLINE", and ▾.
- With configs present, click `+ Add Printer` in the selector to add another.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- Use a TEST-NET address such as `192.0.2.10`, never the real printer's host, serial, or access code. Any credentials go into the host keyring.

- **Open (observed 2026-10-05).** Run `$S/wd.ts text "button[aria-label='printer connection status']"`. It prints `No PrinterOFFLINE▾`. Run `$S/wd.ts click "button[aria-label='printer connection status']"` and `$S/wd.ts wait "[role=dialog][aria-label='Printer selector']"`. A fresh run shows "No printers configured" and `+ Add your first printer`.
- **Validation (observed 2026-10-05).** Click `text=+ Add your first printer`, then `button.printer-selector-submit` with the fields empty. `[role=dialog] [role=alert]` reads "All fields are required".
- **Add (observed 2026-10-05).** Each input sits in a `<label>` with a caption: `Name`, `Host / IP`, `Serial Number`, and `Access Code` (`PrinterSelector.tsx:196-236`). Address an input by its caption: `$S/wd.ts type 'xpath=//label[span[normalize-space()="Name"]]/input' T1`, and the same for `Host / IP` (`192.0.2.10`), `Serial Number` (`01P00A000000000`), and `Access Code` (`12345678`). Then click `button.printer-selector-submit`. With the name `T1`, the badge prints `T1OFFLINE▾`. `DB` gains a `printer_configs` row with `access_code_keychain_id = printer:<id>:access_code`. Adding does not connect.
- **Switch (observed 2026-10-05).** Click `button[aria-label='Switch to T1']`. `button[aria-label=Disconnect]` appears, and after 4 s `$S/wd.ts text ".status-online"` prints `Offline · T1`. Per the source, the badge goes through `Connecting…` and then `Reconnecting`, and `[role=alert][aria-label='Connection error']` appears. `button[aria-label='Retry connection']` appears only when the printer is offline with a last error, after minutes of backoff.
- **Disconnect (observed 2026-10-05).** Click `button[aria-label=Disconnect]` before you delete the active printer.
- **Delete (observed 2026-10-05).** Run `$S/wd.ts hover 'xpath=//li[.//button[@aria-label="Delete T1"]]'`, which hovers the row that owns the button even when several printers are listed, then `$S/wd.ts click 'button[aria-label="Delete T1"]'`. The row disappears from the list. Per the source, it also leaves `printer_configs`.
- **Dialog buttons (observed 2026-10-05).** With one config `T1`, the selector holds "Close printer selector", "Switch to T1", "Delete T1", and "+ Add Printer".

## Gotchas

- `wd.ts text` on the badge joins its three spans, so it prints `No PrinterOFFLINE▾`. The `X · Y` form is the status bar `.status-online`, not the badge.
- The Delete button has opacity 0 until its row is hovered (`.printer-selector-item:hover .printer-selector-delete`). WebDriver treats it as not displayed, so `wd.ts hover` the row first.
- Deleting the active printer does not stop its connection loop. Disconnect first.
- Switching while the badge reads `Reconnecting` fails with "printer service already running".
- Access codes go to the OS keyring through the `keyring` crate's `linux-native` backend (kernel keyutils, no daemon). `m3d.sh up` gives each run its own session keyring, but the backend also links entries into the user's persistent keyring, so a code may outlive the run. This was not tested. Delete test configs before `down`.
- A successful connection, telemetry, and the `MQTT`/`CLOUD` badge need the real P2S. It sits on a separate VLAN, and the Linux host has no confirmed route to it.
- The onboarding printer form is a different, currently broken path, see [onboarding](./onboarding.md).
