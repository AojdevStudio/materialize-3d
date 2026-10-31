# Install Materialize 3D on a Mac

Materialize 3D uses a disk image for Macs with Apple Silicon. You do not need Git, Bun, Rust, Xcode, a source checkout, or a CAD runtime cache.

Use these steps with the 0.2.1 DMG if it is published on the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases). That page reports distribution status. Publication requires an attached software acceptance record for the exact download, as the [release notes](releases/v0.2.1.md) describe. Releases before 0.2.0 do not contain all the capabilities described here.

## Requirements

- **Mac:** Apple Silicon (M1 or later) with macOS 26.0 or later. Intel Macs are not supported.
- **Bambu Studio 02.08.02.61:** free from [Bambu Lab's release page](https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61). Materialize 3D uses it to slice signs and parts. The app does not install or bundle it.
- **An Anthropic or OpenAI API key:** the in-app assistant uses it. The provider bills each request at its own rates. Materialize 3D is free and adds no charge. CAD generation, checks, slicing, and export run on your Mac. The assistant sends chat requests to the selected provider.
- **To print:** a Bambu Lab P2S with a 0.4 mm nozzle. Three-color signs need an AMS and three filaments. Parts use the filaments specified by their design.

## Install

1. Download `Materialize-3D-0.2.1-macos-arm64.dmg` from the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases).
2. Compare the downloaded DMG's full SHA-256 with both the `.sha256` file and the software acceptance record attached to that release. Stop on a mismatch or missing evidence.

   ```bash
   shasum -a 256 ~/Downloads/Materialize-3D-0.2.1-macos-arm64.dmg
   ```

3. Open the disk image and drag **Materialize 3D** into **Applications**.
4. Open Materialize 3D from Applications. The release procedure requires Developer ID signing and Apple notarization. Confirm the download prompt. If macOS rejects the app, keep the error for the release report.
5. In the first-run setup, choose Anthropic or OpenAI and paste your API key. You can skip this and add the key later in **Settings > Agent**. The key is stored in your macOS Keychain. Both providers remain available. For the 0.2.1 acceptance run, choose OpenAI and record the selected model.

## Updates

At launch, Materialize 3D checks the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases) for a newer release. When one exists, a strip under the toolbar shows the new version with **Update now** and **Later**.

- **Update now** downloads the update, checks its signature, backs up your data, installs the update, and restarts the app.
- **Later** keeps the current version running. The app asks again at the next launch.

Nothing installs without your click. If the check or the download fails, the app shows the error and keeps running. **Settings > About** shows the installed version and has a **Check for updates** button.

Before it installs, the app copies its database and print queue to `~/Library/Application Support/com.aojdevstudio.materialize3d/backups/<old version>-to-<new version>-<time>/`. If that copy fails, the app does not update. Your settings, designs, and keys stay where they are.

The first version with updates must be installed from its DMG. Later versions arrive through **Update now**.

## Set up Bambu Studio

Materialize 3D looks for Bambu Studio 02.08.02.61 in `/Applications`, in `~/Applications`, and in folders one level inside `~/Applications`. **Settings > Bambu Studio** shows the version and location it found.

If you already use a different Bambu Studio version, keep it. Install 02.08.02.61 alongside it:

1. Download the macOS disk image from [Bambu Lab's 02.08.02.61 release](https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61) and open it.
2. In Finder, create a folder named `BambuStudio-02.08.02.61` inside your home folder's `Applications` folder.
3. Drag `BambuStudio.app` from the disk image into that new folder. Do not drag it into `/Applications`, which would replace your current copy.
4. In Materialize 3D, open **Settings > Bambu Studio**. If the app did not find 02.08.02.61, click **Choose Bambu Studio…** and select the copy you just installed.

Materialize 3D refuses other Bambu Studio versions, because its slicing checks are validated against this one.

## Make a sign

1. Describe the sign in the assistant panel, for example: "Make an 80 x 50 mm sign that says HELLO in navy on a white base."
2. The app builds the sign, slices it with Bambu Studio, and runs geometry and slice checks. The Signs view shows the preview and every check.
3. Review it and click **Approve**. Only you can approve. The assistant cannot. Any change to the design makes a new revision that needs its own approval.
4. Click **Export 3MF** and save the file.
5. Open the file in Bambu Studio, map the three filaments to your AMS slots, and print from Bambu Studio.
6. Back in the Signs view, record whether the print passed or failed.

## Make a part

1. In the assistant panel, describe the part and give its dimensions, material, and fit requirements.
2. Review the generated part in the Signs view. Parts share this list with signs. The part detail shows a rendered view, revisions, measured requirements, and check results.
3. Review all print warnings before you click **Approve**. Approval records those warnings and the exact package hash.
4. Click **Export 3MF** and save the file through the macOS Save dialog.
5. Open the 3MF as a project in Bambu Studio. Keep the project settings and check the P2S 0.4 mm profile, dimensions, materials, and supports before printing.

The installed app supplies the CAD helper and pinned runtime for parts. A missing or rejected runtime makes parts unavailable. Do not install Python packages or point the app at a developer cache to make an acceptance run pass.

Checks do not replace a physical test print. Materialize 3D does not send jobs to the printer. Use the [installed GUI checklist](verify-on-mac.md) to verify both workflows before a release.

## Uninstall

1. Quit the app and drag **Materialize 3D** from Applications to the Trash.
2. To remove your data, delete `~/Library/Application Support/com.aojdevstudio.materialize3d`.
3. To remove stored keys, open Keychain Access and delete the items named `com.materialize3d`.
