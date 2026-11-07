---
name: fabricate
description: Turn a request for a printed part into params, a checked model, a preview, an HTML guide, and a print-ready 3MF for a Bambu Lab P2S. Use for every job in Materialize 3D.
---

# Fabricate a part

The end of every job is a print-ready 3MF file. Everything else supports that. Work in the project folder, which is your working directory.

## Steps

1. **Parameters.** Write the design as numbers in `params.json`. Mark a measurement you do not know as `"TBD"` with your best estimate beside it, so the person does not have to measure before they see anything. Ask only for what you cannot estimate.
2. **Model and fit checks.** Write Python build scripts in `build/` that read `params.json`. Build the parts with manifold3d (`uv run --with manifold3d --with numpy python build/model.py`). Check that the parts are manifold, that parts that should not touch do not overlap, and that clearances match the parameters. Say what you checked and the numbers.
3. **Preview.** Export the parts to STL (or GLB) in the project folder so the person can turn them in the viewer. When they ask to see a model before the 3MF, this is the step they mean.
4. **HTML guide.** Write a self-contained HTML page: a technical drawing with dimensions, an interactive three.js assembly guide, or both, as the job needs.
5. **Slice to 3MF.** Slice with the Bambu Studio CLI for the P2S and write print-ready 3MF files into `print/`.
   - On macOS the CLI is `/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`. Its system presets are in `~/Library/Application Support/BambuStudio/system/BBL`, or `/Applications/BambuStudio.app/Contents/Resources/profiles/BBL` before Bambu Studio has been opened once.
   - The CLI does not follow a preset's `inherits` chain, so merge each preset with its parents into a full JSON file first.
   - Default presets: machine `Bambu Lab P2S 0.4 nozzle`, process `0.20mm Standard @BBL P2S`, filament `Bambu PETG Basic @BBL P2S 0.4 nozzle`, unless the person names others.
   - Check that the bed is 256 x 256 mm after the merge.
   - If Bambu Studio is not installed on this machine, say so plainly and leave the STL files ready.

Keep each step's script, so a change to `params.json` rebuilds everything.

## Astra, the GPT helper

You can hand a task to Astra through the codex CLI. Astra suits drawings and second opinions. Run it from the project folder:

```
codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write "<the task, the files to read, and the file to write>"
```

Add `-i <image>` to give Astra a picture. Astra cannot see this chat, so the task must say everything it needs. Check what Astra writes before you show it.
