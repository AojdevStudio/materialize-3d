# Onboarding

On first launch, a four-step wizard welcomes the user, asks for an AI provider and API key, offers printer setup, and summarizes what was configured. Launching the app from the last step records completion, so later launches go straight to the main UI.

## Sub-features

- `onboarding-welcome` shows the welcome card and `Get Started`.
- `onboarding-llm` offers the provider radios `Anthropic` and `OpenAI`, an API key field, an optional `input-base-url` server address field, `Continue`, and `Skip for now`. A typed key is saved to the keyring under `api_key:<provider>`. The address field shows the active provider's saved address and is empty for the other provider. On `Continue`, a field that differs from the chosen provider's saved address replaces it in `agent.base_url:<provider>`, so a blank field clears an address saved earlier. With no key typed and the field equal to the active provider's saved address, `Continue` saves nothing. The address must be `https://`, or `http://` to a loopback or private address, with no user name, password, query, or fragment.
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
- **Enter a key.** Click `[data-testid=provider-openai]`, then `KEY=<key> $S/wd.ts type-secret "[data-testid=input-api-key]" KEY` (a password field), then click `Continue`. Continue saves the key to the keyring under `api_key:<provider>` first, then moves to the printer step at once. `[data-testid=api-key-stored]` shows on the provider step only for a key stored before, so prove the save in Settings (`agent-key-state` reads "Key stored") or after a relaunch. If saving fails, the step stays put and `[data-testid=api-key-error]` shows the reason. When the chosen provider is not the current one, `DB` gains `agent.model` for it.
- **Invalid address (observed 2026-11-03).** Type `http://gateway.example/v1` into `input-base-url` and click `text=Continue`. The step stays put, and `api-key-error` reads "the server address must start with https://, or http:// for a loopback or private address". `Continue` makes the chosen provider active before it saves the address, so `DB` already holds `agent.model` for that provider even though the address was refused.
- **Key draft on a provider switch (observed 2026-11-02, again 2026-11-03).** Clicking the provider that is already selected keeps the draft (length 18 for `sk-test-dummy-0000`). On the provider step with Anthropic selected, type `sk-test-dummy-0000` into `input-api-key`, then click `[data-testid=provider-openai]`. `$S/wd.ts eval 'return document.querySelector("[data-testid=input-api-key]").value.length'` prints `0`. After `Continue`, Settings reads "No key stored". Before the fix for issue 95, the field kept the draft and Continue stored it as the OpenAI key.
- **Skip provider (observed 2026-09-25).** Run `$S/wd.ts click "[data-testid=btn-llm-skip]"` and `$S/wd.ts wait "[data-testid=step-bambu]"`. `[data-testid=printer-not-detected]` reads "No printer detected". The inputs `input-host`, `input-access-code`, and `input-device-id` and the button `btn-test-connection` are present.
- **Test Connection (observed 2026-11-03).** Type `127.0.0.1` into `input-host` and `01P00A000000000` into `input-device-id`, then `CODE=12345678 $S/wd.ts type-secret "[data-testid=input-access-code]" CODE`. Click `btn-test-connection`. After about 5 s the step reads "Connection failed — check credentials and network." A second click adds a second row: `select name, host, serial, is_default from printer_configs` shows two rows for `127.0.0.1`, one with `is_default = 1`. The summary still reads "Bambu Printer: Not configured", and the toolbar selector lists both rows.
- **Skip printer (observed 2026-10-05).** Run `$S/wd.ts click "[data-testid=btn-bambu-skip]"` and `$S/wd.ts text "[data-testid=setup-summary]"`. The summary has two lines and reads "—AI provider: Not configured—Bambu Printer: Not configured".
- **Launch (observed 2026-10-05).** The last button reads "Launch App". Run `$S/wd.ts click "[data-testid=btn-launch-app]"`, `$S/wd.ts gone "[data-testid=onboarding-wizard]"`, and `$S/wd.ts wait "nav[aria-label=Primary]"`. The main UI shows the sidebar with `Library` current.
- **Side effect (observed 2026-10-05).** Read `select key, value from settings` from `DB`. It contains `onboarding.completed = true`.
- **Persistence (observed 2026-10-05).** Run `$S/wd.ts end`, `$S/wd.ts session`, `$S/wd.ts wait "nav[aria-label=Primary]" 30000`, and `$S/wd.ts count "[data-testid=onboarding-wizard]"`. The count prints `0`.

## Gotchas

- `Test Connection` saves the entered values and sets the configuration as default before attempting a connection. For an isolated check, use a loopback host and test credentials, then verify the saved host, serial, and default flag in `printer_configs`. A connection failure is expected without a printer. Repeated clicks still create duplicate configurations, tracked in issue #51.
- `Continue` on either step works without configuring anything, just like `Skip for now`. With a key typed on the provider step, `Continue` saves it first and stays on the step if saving fails. Verify both buttons if a change touches navigation between steps.
- The wizard renders before `close-inspector` can run, so take the welcome screenshot after closing the inspector or the page will be 600px tall.
- The contrast sweep that `shot` runs reports three onboarding controls that the baseline does not list: `button "btn-llm-skip"` and `button "btn-bambu-skip"` at 2.70 and `input "input-api-key" (placeholder)` at 2.83 **(observed 2026-11-03)**. They draw `--text-tertiary`, the same cause as the baseline entries. The baseline was measured without onboarding. Do not add them to get a sweep green.
- A delayed first status response that selects another provider also clears the key draft (`OnboardingWizard.tsx`, the provider effect). This was not driven.
