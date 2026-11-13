# Settings

The gear in the sidebar footer opens Settings in place of the studio. Settings has its own nav on the left with four sections: Agents and models, Slicer and printer, Build tools, and Projects folder. It shows one section at a time. Agents and models shows each sign-in's state and the default model new projects start with. Slicer and printer shows Bambu Studio's state and the chosen printer with `Change`. Build tools shows uv and Python. Projects folder shows where projects live, with `Reveal`. A row that is not Ready has `Fix in setup`, which opens Check your Mac, as the [studio](./studio.md) banner does. `Change` opens setup's printer step. `Back` in setup returns to the same Settings section. `Close` returns to the screen Settings was opened from.

## Sub-features

- `settings-open` is the gear. `settings` is the whole screen. The nav is `nav[aria-label="Settings"]`, and its current section has `aria-current="page"`. The shown section is `section[aria-label="<section name>"]`.
- `settings-claude`, `settings-chatgpt`, `settings-bambu`, `settings-uv`, and `settings-python` are the rows. They use setup's check rules, so `.setup-status` and `.setup-detail` read the same as in [setup](./setup.md).
- The default model is a radio list, `input[name=settings-model]`. A pick saves at once through `settings.set`. The start screen's model button shows the new pick after `Close`.
- `settings-printer` holds the printer preset name, its filament and process, and `Change`.
- Projects folder shows the path in a `code` element. `Reveal` opens the file manager at the folder.

## How to get to it (user POV)

- Finish [setup](./setup.md). On the start screen or in a project, press the gear at the bottom left of the sidebar.

## Driving it with wd.ts

```bash
$S/wd.ts wait '[data-testid=start-screen]' 30000
$S/wd.ts click '[data-testid=settings-open]'
$S/wd.ts wait '[data-testid=settings]'
$S/wd.ts wait "xpath=//*[@data-testid='settings-claude']//*[normalize-space()='Ready']" 30000
$S/wd.ts click "xpath=//label[contains(@class,'settings-option')][normalize-space()='Sonnet 5.5']/input"
$S/wd.ts click "xpath=//nav[@aria-label='Settings']/button[normalize-space()='Slicer and printer']"
$S/wd.ts click "xpath=//*[@data-testid='settings-printer']//button[normalize-space()='Change']"
$S/wd.ts wait '[data-testid=setup]'
$S/wd.ts click 'text=Back'
$S/wd.ts wait 'section[aria-label="Slicer and printer"]'
$S/wd.ts click 'text=Close'
$S/wd.ts wait '[data-testid=start-screen]'
```

Prove a model pick saved by a relaunch: `$S/wd.ts end`, `$S/wd.ts session`, then open Settings again and read the checked radio.

## Gotchas

- Settings reads its rows each time it opens, so a fix made in setup shows when `Back` or `Continue` returns to it.
- The Bambu Studio row stays Checking for the seconds Bambu Studio takes to answer `--help`.
- `Reveal` opens a window outside the webview. WebDriver cannot see it, so prove it with a desktop screenshot.
