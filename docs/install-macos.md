# Install Materialize 3D on a Mac

Materialize 3D ships as a disk image for Macs with Apple Silicon. You do not need Git, Bun, Rust, or Xcode.

## Requirements

- **Mac:** Apple Silicon (M1 or later) with macOS 26.0 or later. Releases after 0.1.0 require macOS 26.0; 0.1.0 itself declared macOS 13 but is tested only on macOS 26.7. Intel Macs are not supported.
- **Bambu Studio 02.08.02.61:** free from [Bambu Lab's release page](https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61). Materialize 3D uses it to slice signs. The app does not install or bundle it.
- **An Anthropic or OpenAI API key:** the in-app assistant uses it. The provider bills each request at its own rates. Materialize 3D is free and adds no charge. Building, checking, and exporting a sign run on your Mac.
- **To print:** a Bambu Lab P2S with an AMS and three filaments. The P2S with a 0.4 mm nozzle is the only validated printer.

## Install

1. Download `Materialize-3D-0.1.0-macos-arm64.dmg` from the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases).
2. Optional: check the download against the `.sha256` file on the same page:

   ```bash
   shasum -a 256 ~/Downloads/Materialize-3D-0.1.0-macos-arm64.dmg
   ```

3. Open the disk image and drag **Materialize 3D** into **Applications**.
4. Open Materialize 3D from Applications. The app is signed with a Developer ID and notarized by Apple, so macOS asks only to confirm that you want to open an app downloaded from the internet.
5. In the first-run setup, choose Anthropic or OpenAI and paste your API key. You can skip this and add the key later in **Settings > Agent**. The key is stored in your macOS Keychain.

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
2. The app builds the sign, slices it with Bambu Studio, and runs 27 geometry and slice checks. The Signs view shows the preview and every check.
3. Review it and click **Approve**. Only you can approve. The assistant cannot. Any change to the design makes a new revision that needs its own approval.
4. Click **Export 3MF** and save the file.
5. Open the file in Bambu Studio, map the three filaments to your AMS slots, and print from Bambu Studio.
6. Back in the Signs view, record whether the print passed or failed.

The checks prove that the slice matches the design. They do not replace a test print. Materialize 3D 0.1.0 does not send jobs to the printer.

## Uninstall

1. Quit the app and drag **Materialize 3D** from Applications to the Trash.
2. To remove your data, delete `~/Library/Application Support/com.aojdevstudio.materialize3d`.
3. To remove stored keys, open Keychain Access and delete the items named `com.materialize3d`.
