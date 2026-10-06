# Onboarding

On first launch, a four-step wizard welcomes the user, asks for an AI provider and API key, offers printer setup, and summarizes what was configured. Launching the app from the last step records completion, so later launches go straight to the main UI.

## Sub-features

- `onboarding-welcome` shows the welcome card and `Get Started`.
- `onboarding-llm` offers the provider radios `Anthropic` and `OpenAI`, an API key field, `Continue`, and `Skip for now`. A typed key is saved to the keyring under `api_key:<provider>`.
- `onboarding-bambu` shows printer detection and a manual host, access code, and serial form with `Test Connection`.
- `onboarding-complete` summarizes provider and printer status in two lines and offers `Launch App`.
- `onboarding-persist` means a relaunch after completion skips the wizard.

## How to get to it (user POV)

- Launch the app with no stored `onboarding.completed` setting. Every fresh `m3d.sh up` run qualifies.
- To see it again inside a run, `down` and `up` for a fresh data dir. There is no in-app entry point.

## Driving it with wd.ts

Preconditions:

- A fresh run with no prior session. `doctor` shows the DB path inside the run dir once a session exists.

- **Welcome (observed 2026-09-25).** Run `$S/wd.ts wait "[data-testid=step-welcome]"` and `$S/wd.ts shot onboarding-welcome`. The card reads "Ideas to Atoms", and 4 step dots appear in `[data-testid=step-indicator]`.
- **Start (observed 2026-10-05).** Run `$S/wd.ts click "[data-testid=btn-get-started]"` and `$S/wd.ts wait "[data-testid=step-llm]"`. The provider step shows the radios `[data-testid=provider-anthropic]` and `[data-testid=provider-openai]` (role=radio, labels "Anthropic" and "OpenAI"). `$S/wd.ts count "[data-testid=provider-openai]"` prints `1`, and `$S/wd.ts count "[data-testid=btn-signin-anthropic]"` prints `0`.
- **Enter a key.** Click `[data-testid=provider-openai]`, then `$S/wd.ts type "[data-testid=input-api-key]" "<key>"` (a password field), then click `Continue`. Continue saves the key to the keyring under `api_key:<provider>` first. `[data-testid=api-key-stored]` confirms a stored key. If saving fails, the step stays put and `[data-testid=api-key-error]` shows the reason. When the chosen provider is not the current one, `DB` gains `agent.model` for it.
- **Skip provider (observed 2026-09-25).** Run `$S/wd.ts click "[data-testid=btn-llm-skip]"` and `$S/wd.ts wait "[data-testid=step-bambu]"`. `[data-testid=printer-not-detected]` reads "No printer detected". The inputs `input-host`, `input-access-code`, and `input-device-id` and the button `btn-test-connection` are present.
- **Skip printer (observed 2026-10-05).** Run `$S/wd.ts click "[data-testid=btn-bambu-skip]"` and `$S/wd.ts text "[data-testid=setup-summary]"`. The summary has two lines and reads "—AI provider: Not configured—Bambu Printer: Not configured".
- **Launch (observed 2026-10-05).** The last button reads "Launch App". Run `$S/wd.ts click "[data-testid=btn-launch-app]"`, `$S/wd.ts gone "[data-testid=onboarding-wizard]"`, and `$S/wd.ts wait "nav[aria-label=Primary]"`. The main UI shows the sidebar with `Library` current.
- **Side effect (observed 2026-10-05).** Read `select key, value from settings` from `DB`. It contains `onboarding.completed = true`.
- **Persistence (observed 2026-10-05).** Run `$S/wd.ts end`, `$S/wd.ts session`, `$S/wd.ts wait "nav[aria-label=Primary]" 30000`, and `$S/wd.ts count "[data-testid=onboarding-wizard]"`. The count prints `0`.

## Gotchas

- `Test Connection` sends the form's initial empty values, whatever was typed, because its callbacks have empty dependency lists (`OnboardingWizard.tsx:168-172`, `:214`). It also calls a command that is not registered (`set_default_printer_config`, `lib.rs:130-138`). Expect "Connection failed". It may also leave a `printer_configs` row whose name falls back to "My Printer". This is a known defect and not a harness problem.
- `Continue` on either step works without configuring anything, just like `Skip for now`. With a key typed on the provider step, `Continue` saves it first and stays on the step if saving fails. Verify both buttons if a change touches navigation between steps.
- The wizard renders before `close-inspector` can run, so take the welcome screenshot after closing the inspector or the page will be 600px tall.
