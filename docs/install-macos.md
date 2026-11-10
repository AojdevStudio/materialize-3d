# Install Materialize 3D on a Mac

Materialize 3D uses a disk image for Macs with Apple Silicon. You do not need Git, Bun, Rust, Xcode, or a source checkout.

Use these steps with the DMG on the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases). That page reports distribution status.

## Requirements

- **Mac:** Apple Silicon (M1 or later) with macOS 26.0 or later. Intel Macs are not supported.
- **A sign-in to one inference provider:** Claude, ChatGPT, or OpenCode Go. Claude takes a subscription sign-in or an API key. ChatGPT takes only its own sign-in. OpenCode Go takes only an API key. The agent uses it. Your provider's plan or API charges apply. Materialize 3D is free and adds no charge.
- **uv and a Python it can run:** the agent runs its build and check scripts with [uv](https://docs.astral.sh/uv/). After you install uv, run `uv python install` in Terminal.
- **Bambu Studio 02.08.02.61:** free from [Bambu Lab's release page](https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61). Materialize 3D uses it to slice. The app does not install or bundle it.
- **To print:** a Bambu Lab P2S with a 0.4 mm nozzle.

## Install

1. Download `Materialize-3D-<version>-macos-arm64.dmg` from the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases).
2. Compare the downloaded DMG's full SHA-256 with the `.sha256` file attached to that release. Stop on a mismatch. In the command, replace `<version>` with the release's version.

   ```bash
   shasum -a 256 "$HOME/Downloads/Materialize-3D-<version>-macos-arm64.dmg"
   ```

3. Open the disk image and drag **Materialize 3D** into **Applications**.
4. Open Materialize 3D from Applications. Confirm the download prompt.
5. On the start screen, the app names what the agent still lacks: a sign-in, uv, or a Python. Sign in through the app's own control. The sign-in is stored in your macOS Keychain. Send turns on once nothing is missing.

## Updates

At launch, Materialize 3D checks the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases) for a newer release. When one exists, a strip at the top of the chat shows the new version with **Update now** and **Later**.

- **Update now** downloads the update, checks its signature, waits until the agent's work is done, installs the update, and restarts the app.
- **Later** keeps the current version running. The app asks again at the next launch.

Nothing installs without your click. If the check or the download fails, the app shows the error and keeps running.

## Set up Bambu Studio

Materialize 3D looks for Bambu Studio 02.08.02.61 in `/Applications`, in `~/Applications`, and in folders one level inside `~/Applications`. It refuses other Bambu Studio versions, because its slice step is validated against this one.

If you already use a different Bambu Studio version, keep it. Install 02.08.02.61 alongside it:

1. Download the macOS disk image from [Bambu Lab's 02.08.02.61 release](https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61) and open it.
2. In Finder, create a folder named `BambuStudio-02.08.02.61` inside your home folder's `Applications` folder.
3. Drag `BambuStudio.app` from the disk image into that new folder. Do not drag it into `/Applications`, which would replace your current copy.

## Make something

1. Describe the object on the start screen, for example: "Make a 20 mm calibration cube and slice it to a 3MF for the P2S."
2. The agent works in the chat's project folder, `~/Documents/Materialize 3D/<date>-<slug>/`. The right panel shows the model and the other files it writes.
3. Open the Files tab. A sliced 3MF is listed under **Print files**.
4. Click **Open in Bambu Studio**, check the plate and the settings, and print from Bambu Studio. Materialize 3D does not send jobs to the printer.

## Uninstall

If you used version 0.2.2 on this Mac, steps 2 and 4 also delete its data. Step 2 deletes `materialize.db` and the update backups. Step 4 deletes your 0.2.2 API keys and printer access codes. Copy anything you want to keep first. The [0.3.0 release notes](releases/v0.3.0.md#your-data) list where that data is.

1. Quit the app and drag **Materialize 3D** from Applications to the Trash.
2. To remove your chats, delete `~/Library/Application Support/com.aojdevstudio.materialize3d`.
3. To remove the project folders, delete `~/Documents/Materialize 3D`.
4. To remove stored sign-ins, open Keychain Access and delete the items named `com.materialize3d`.
