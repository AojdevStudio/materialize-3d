# Onboarding

On first launch, a four-step wizard welcomes the user, offers AI provider sign-in, offers printer setup, and summarizes what was configured. Launching the app from the last step records completion, so later launches go straight to the main UI.

## Sub-features

- `onboarding-welcome` shows the welcome card and `Get Started`.
- `onboarding-llm` offers Anthropic and OpenAI Codex sign-in, `Continue`, and `Skip for now`.
- `onboarding-bambu` shows printer detection and a manual host, access code, and serial form with `Test Connection`.
- `onboarding-complete` summarizes provider and printer status and offers `Launch`.
- `onboarding-persist` means a relaunch after completion skips the wizard.

## How to get to it (user POV)

- Launch the app with no stored `onboarding.completed` setting. Every fresh `m3d.sh up` run qualifies.
- To see it again inside a run, `down` and `up` for a fresh data dir. There is no in-app entry point.

## Driving it with wd.ts

Preconditions:

- A fresh run with no prior session. `doctor` shows the DB path inside the run dir once a session exists.

- **Welcome (observed 2026-09-25).** Run `$S/wd.ts wait "[data-testid=step-welcome]"` and `$S/wd.ts shot onboarding-welcome`. The card reads "Ideas to Atoms", and 4 step dots appear in `[data-testid=step-indicator]`.
- **Start (observed 2026-09-25).** Run `$S/wd.ts click "[data-testid=btn-get-started]"` and `$S/wd.ts wait "[data-testid=step-llm]"`. The provider step shows `[data-testid=btn-signin-anthropic]` and `[data-testid=btn-signin-openai-codex]`.
- **Skip provider (observed 2026-09-25).** Run `$S/wd.ts click "[data-testid=btn-llm-skip]"` and `$S/wd.ts wait "[data-testid=step-bambu]"`. `[data-testid=printer-not-detected]` reads "No printer detected". The inputs `input-host`, `input-access-code`, and `input-device-id` and the button `btn-test-connection` are present.
- **Skip printer (observed 2026-09-25).** Run `$S/wd.ts click "[data-testid=btn-bambu-skip]"` and `$S/wd.ts text "[data-testid=setup-summary]"`. The summary lists Anthropic, OpenAI, and Bambu Printer as "Not configured".
- **Launch (observed 2026-09-25).** Run `$S/wd.ts click "[data-testid=btn-launch-app]"`, `$S/wd.ts gone "[data-testid=onboarding-wizard]"`, and `$S/wd.ts wait "nav[aria-label=Primary]"`. The main UI shows six sidebar buttons, with `Library` current.
- **Side effect (observed 2026-09-25).** Read `select key, value from settings` from `DB`. It contains `onboarding.completed = true`.
- **Persistence (observed 2026-09-25).** Run `$S/wd.ts end`, `$S/wd.ts session`, `$S/wd.ts wait "nav[aria-label=Primary]" 30000`, and `$S/wd.ts count "[data-testid=onboarding-wizard]"`. The count prints `0`.

## Gotchas

- Provider `Sign in` opens a system browser for OAuth and needs network and a real subscription. Xvfb has no browser, so treat it as unreachable here.
- `Test Connection` sends the form's initial empty values, whatever was typed, and calls a command that is not registered (`set_default_printer_config`). Expect "Connection failed". It may also leave an empty "My Printer" row in `printer_configs`. This is a known defect and not a harness problem.
- `Continue` on either step works without configuring anything, just like `Skip for now`. Verify both buttons if a change touches navigation between steps.
- The wizard renders before `close-inspector` can run, so take the welcome screenshot after closing the inspector or the page will be 600px tall.
