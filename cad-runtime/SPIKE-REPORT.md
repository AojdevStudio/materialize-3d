# CAD worker spike report (PR 5)

A signed Rust helper boots a sealed arm64 Linux guest with Apple's Virtualization framework on the Mac mini. The guest runs one build123d script and returns STEP plus a body manifest over vsock. A second fresh guest runs only the pinned inspector and returns a bounded mesh, and the host decodes and checks it in Rust. All nine restriction tests held against the real VM. A whole uncached build (two cold guests) took 6.6 s on the M4. Two stop-line items stay open as gates for Ossie: notarization was not attempted, and a real Linux boot on macOS 13.0 cannot be tested on any hardware we have.

Everything here was measured on the Mac mini (Apple M4, 10 cores, 24 GiB, macOS 26.7) and on aojdevlinux (x86_64) on 2026-10-02. The app does not use any of it yet.

## Stop-line facts

| Item | Result |
|---|---|
| Notarization | **Untested: blocked pending gate G2.** The Developer ID identity and the notarytool API key exist and are reachable (below), but the agent's permission classifier denied using the release keychain and the BWS Apple API values. The helper is signed ad hoc with the virtualization entitlement and the hardened runtime. |
| Quarantined-DMG boot on macOS 13.0 | **Partly untestable: gate G1.** A macOS 13.0 (22A380) guest installs and boots on the M4 under the Virtualization framework. A Linux guest cannot boot inside any macOS guest, because Apple exposes nested virtualization only on `VZGenericPlatformConfiguration` (Linux guests, macOS 15 and later). A real Linux boot on macOS 13.0 needs a physical M1 or M2 Mac running 13.0. |
| Restriction tests | **All nine held** on the real VM on the mini. Log: `cad-runtime/evidence/restriction-tests.log`, sha256 `caca8a08f6a3e86604040aad6cc6032a4d55562cc1f1b6410a4ef2899fbbddb0`. |

### Notarization (G2)

Where the material is: the mini's `~/Library/Keychains/keepfolio-release.keychain-db` holds one valid Developer ID Application identity. Its team matches the TeamIdentifier of the installed, notarized Materialize 3D 0.1.0. The keychain is locked and outside the search list; its password is most likely BWS `KEEPFOLIO_RELEASE_KEYCHAIN_PASSWORD` (not verified). The notarytool key is BWS `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, and `APPLE_API_PRIVATE_KEY`, the same variables `scripts/release/build-macos.sh` reads. The commands below run once Ossie allows agents to use that keychain and those values. They follow the release script, which feeds the keychain password to `security -i` on stdin and writes the `.p8` key to a mode-600 file:

```bash
# on the mini, in ~/m3d-scratch/pr5-worker-spike/cad-host, with RELEASE_KEYCHAIN unlocked for this session
identity="$(security find-identity -v -p codesigning "$RELEASE_KEYCHAIN" | awk '/Developer ID Application/{print $2; exit}')"
security list-keychains -d user -s "${original_keychains[@]}" "$RELEASE_KEYCHAIN"
codesign --force --timestamp --options runtime --entitlements entitlements.plist \
  --keychain "$RELEASE_KEYCHAIN" --sign "$identity" target/release/materialize-cad-host
security list-keychains -d user -s "${original_keychains[@]}"
ditto -c -k --keepParent target/release/materialize-cad-host materialize-cad-host.zip
xcrun notarytool submit materialize-cad-host.zip --key "$keyfile" --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER_ID" --wait
spctl --assess --type execute -vv target/release/materialize-cad-host   # expect: source=Notarized Developer ID
HELPER=$PWD/target/release/materialize-cad-host RUNTIME=$PWD/../runtime restriction-tests/run-all.sh
```

A bare Mach-O can be notarized but not stapled. In the product the helper lives at `Contents/MacOS/materialize-cad-host` inside the app bundle, which the release script already notarizes and staples.

### macOS 13.0 (G1)

Stage A evidence is in `cad-host/probes/macos13-guest/` (`main.swift`, `logs/`). The restore image matched Apple's published sha256 (`537008900fe3...4f2d090`). `inspect` reported `isSupported=true` and a supported hardware model (minimum 2 CPUs, 4096 MiB). `install` finished in 318 s. On boot, the guest's DHCP lease changed 4 s after start, and it answered ping while running and stopped answering once stopped.

The installed guest is kept for PR 6, uncommitted, on the mini: `~/m3d-scratch/pr5-macos13/` (`UniversalMac_13.0_22A380_Restore.ipsw` and the `vm-13.0` bundle, 26 GB together). In that guest PR 6 can test Gatekeeper and notarization acceptance of a quarantined DMG, the helper's launch with its signature and entitlement, and the helper's clean failure when virtualization is unavailable. Running anything in it first needs one pass through Setup Assistant. Every Virtualization API the helper calls is available on macOS 12.0 or earlier (SDK 27.0 headers), so a 13.0 deployment target compiles, but that is not runtime proof.

## What the spike built

| Path | What it is |
|---|---|
| `cad-host/src/frame.rs` | The guest channel: frames of a 4-byte tag, a u32 length, and a payload. Per-role allowlist, each tag at most once, every length checked against its cap before any read or allocation. |
| `cad-host/src/mesh.rs` | `decode_mesh` (counts checked against the limits and against the bytes present before allocating, finite and bounded coordinates, indices in range, no trailing bytes), the 1 µm weld, and the geometry report (closed manifold, non-degenerate, outward, volume, bounds). |
| `cad-host/src/manifest.rs` | The body manifest: 1 to 16 bodies, names of 1 to 64 printable characters, slots 1 to 16, unknown fields refused. |
| `cad-host/src/vm.rs` | macOS VM driver on `objc2-virtualization` 0.3.2. |
| `cad-host/src/main.rs` | The spike CLI: `generate`, `inspect`, `build`, `hostile`. |
| `cad-runtime/build.sh` | One command that builds the kernel, rootfs, job disk template, test initramfs, and `pins.json` per architecture. |
| `cad-runtime/lock/` | `build123d==0.13.0` resolved to hash-pinned wheel lock files for arm64 and amd64. |
| `cad-runtime/kernel/` | Linux 6.18.54 (kernel.org sha256 pinned): `allnoconfig` plus `arm64.config`; the build fails if any requested option does not stick. |
| `cad-runtime/guest/` | The guest's `init`, `agent.py`, `runner.py`, `inspector.py`, and `materialize.py`. |
| `cad-runtime/test/hostile-guest.c` | The restriction-test stand-in for a fully compromised inspection guest. |
| `cad-runtime/pins-arm64.json`, `pins-amd64.json` | Digests and sizes of the built outputs and their pinned inputs. |
| `cad-host/restriction-tests/` | One script per restriction, plus `run-all.sh`. |
| `cad-host/spike/` | The reference clip, `measure.sh`, `run-hobbyist.sh`, `step-in-3mf.sh`, and the ten hobbyist scripts. |
| `cad-runtime/evidence/` | Logs and results copied back from the runs. |

**Helper language: Rust.** `objc2-virtualization` reached every API the worker needs: Linux boot loader, read-only and read-write disk images, virtio console, entropy, the vsock listener delegate, and forced stop. Swift appears only in the Stage A macOS-guest probe.

**What each guest gets** (`vm.rs` `configure`):
- the uncompressed kernel;
- the erofs root attached read-only (`/dev/vda`);
- a fresh 256 MiB ext4 job disk cloned from the template and deleted afterwards (`/dev/vdb`);
- a console the host reads with a 64 KiB cap;
- an entropy device and one vsock device;
- 2 vCPUs and 2048 MiB.

It gets no network device, no directory share, no USB, and no graphics, and the kernel has no network device drivers, no virtio-fs, no 9p, no FUSE, and no loadable modules. The host refuses to boot unless the kernel, root, and job-disk template match their sha256 pins.

**Channel direction.** The host listens on vsock port 7000 before boot and accepts exactly one connection. The guest agent makes that connection before any job code runs; every later connection is refused and counted. This avoids an ambiguity in Apple's documentation: `connectToPort` "does nothing if the guest does not listen", so host-side retries could race.

**Stopping.** The host's deadline and cancel force-stop the VM whatever the guest is doing. The helper waits, bounded, until the framework allows a stop (a VM that is still starting does not yet), checks the stop's completion error, and confirms the VM halted. `forced_stop` is recorded only from a confirmed stop, and `final_state` records the VM's state at the end. A stop it cannot confirm replaces the result with an error, because the VM may still be running.

**Inside the guest.** The agent runs as PID 1 and execs the job as uid and gid 1000 with no supplementary groups, `no_new_privs`, and an empty environment. The job runs in a cgroup capped at memory.max (guest RAM minus 320 MiB, with no swap in the kernel) and 64 processes, with core dumps off, 256 file descriptors, and 64 MiB per file. Inputs are root-owned and read-only. The agent reads outputs by fixed name with `O_NOFOLLOW`, regular files only, under caps. Guest-to-host frames carry no paths, and the host writes accepted payloads only under names it chooses.

**Two adjustments the real runs required:**
- **Fixed guest clock.** The guest has no RTC, so it boots at 1970, and OpenCascade's STEP writer rejects that date (`Quantity_Date invalid parameters`). The agent sets the clock to 2000-01-01, which also makes STEP headers identical across builds of the same script.
- **Tessellation deflection.** The inspector meshes at 0.02 mm. At 0.01 mm, BRepMesh reported success but left 6 of the clip's 42 faces untriangulated; the inspector fails on that rather than sending a partial mesh.

## The reference part through both guests

The `design.md` Usage clip as first written is `cad-host/spike/cable-clip.py`. It builds through both guests, but **its mesh is not closed**: 468 open edges. The cause is the script's own geometry, not the worker. Filleting after the channels are cut leaves a self-intersecting solid:
- OpenCascade's `BRepCheck_Analyzer` calls it valid.
- `BOPAlgo_ArgumentAnalyzer` flags it faulty.
- Its bounding box runs y from -0.278 to 25.278 on a part cut from a 25 mm block.
- A 0.6 mm fillet on the same edges fails outright.

The same clip with the fillet moved before the channel cut, `cable-clip-fillet-first.py`, is clean. Through both guests it comes back closed, non-degenerate, and outward: 2,100 triangles, mesh volume 14,499.7 mm³ against the B-rep's 14,498.3 mm³. Both results are in `cad-runtime/evidence/cable-clip*/result.json`. So the acceptance line "the reference script builds through both guests and the decoded mesh is closed" holds for the corrected clip and not for the clip as first written. The Rust `closed_manifold` check catching the first version is the design working: PR 7 would fail that build at the `geometry` stage. `design.md` now uses the fillet-first clip (corrected 2026-10-02).

## Measurements

Five cold builds of the fillet-first clip; every guest is a fresh VM (`cad-runtime/evidence/measurements.log`, from `HELPER=... RUNTIME=... cad-host/spike/measure.sh`).

| Step | Median | Range |
|---|---|---|
| Verify runtime digests (860 MB hashed) | 1,592 ms | 1,578 to 1,609 |
| Any guest: framework start call to running | not logged | 66 to 77 (10 guests) |
| Generation guest: cold boot to agent connected | 158 ms | 153 to 168 |
| Generation guest: job (import build123d, run script, export STEP) | 3,619 ms | 3,556 to 3,774 |
| Generation guest: total | 3,998 ms | 3,931 to 4,150 |
| Inspection guest: cold boot | 155 ms | 141 to 158 |
| Inspection guest: job | 631 ms | 577 to 696 |
| Inspection guest: total | 1,011 ms | 940 to 1,079 |
| Whole build, wall clock | 6,620 ms | 6,480 to 6,770 |

Memory:
- **VM process:** peak resident about 1,240 MiB while a guest runs. Guests run one at a time, each with fixed 2 GiB of RAM.
- **Job inside the guest:** peaked at 728 MiB (generation) and 359 MiB (inspection), from cgroup `memory.peak`.
- **Helper:** 27 MiB.

Sizes (`cad-runtime/pins-arm64.json`):

| Item | Size |
|---|---|
| Kernel `Image` | 7.4 MB |
| Root image, erofs lz4hc | 588 MB |
| Root image, lzfse (what a compressed DMG would carry) | 429 MB |
| Root installed (unpacked tree) | 1.20 GB |
| Job disk template | 256 MiB sparse, 92 MB allocated, 175 KB compressed |
| amd64 root (same lock and Dockerfile) | 606 MB erofs, 1.30 GB installed |

**The mini is an M4, not the least capable supported Mac.** That Mac is an 8 GB M1 on macOS 13. Public Geekbench 6 single-core scores put the M1 at roughly 2,300 to 2,400 and the M4 at roughly 3,700 to 3,900, so CPU-bound steps (import, script, STEP export, tessellation, hashing) should take about 1.5 to 1.7 times as long. That estimates about 10 to 11 s per uncached build on an M1; this is an estimate, not a measurement. Memory is the tighter limit on 8 GB: a guest's VM process held about 1.24 GB. Lowering guest RAM to 1.5 GiB would still leave the generation job twice its measured peak. The 1.6 s digest check should run once per app launch, or lean on the signed bundle's seal, rather than run per build.

## Restriction tests

Run on the mini with `HELPER=<signed helper> RUNTIME=<runtime dir> cad-host/restriction-tests/run-all.sh`. Each test checks host-side facts, not only the guest's self-report. Final run: 9 passed, 0 failed (log above).

| Test | What it does | Result |
|---|---|---|
| 01 host canary | Writes a random `M3D-CANARY-<uuid>` file on the Mac. The job scans every regular file in the guest and lists mounts and block devices. | **Held.** The guest found no canary. There was no virtiofs, 9p, FUSE, NFS, or CIFS mount, and only `vda,vdb`. The token appears in nothing the host received. |
| 02 network | TCP to 1.1.1.1:443 and 192.168.64.1:22, DNS, UDP to 8.8.8.8:53, and vsock to CID 2 ports 7000/22/80 and CIDs 1 and 3. | **Held.** All 9 blocked, interfaces `lo` only, and the host refused the job's vsock connection. |
| 03 write outside output | Writes to the inspector, agent, build123d, `/etc/passwd`, `/`, the read-only inputs, the job-disk root, `/dev/vda`, `/dev/vdb`, and `/sys`; remount `/` read-write; setuid(0); chown. | **Held.** All 10 writes blocked, remount and privilege calls blocked, job ran as uid 1000 with no groups and an empty environment block (`/proc/self/environ` is empty). Runtime files still match their pins after the run; job disk deleted. |
| 04 fork bomb | Forks until refused; children sleep forever. | **Held.** Forks refused after 63 children (64 processes, the cap); bounded failure in 2 s; VM stopped. |
| 05 exhaust memory | Allocates and touches 64 MiB chunks. | **Held.** The job held 1,664 MiB, then the guest OOM killer killed it at a 1,680 MiB peak, under its 1,728 MiB cgroup cap; the agent reported "job ran out of memory". |
| 06 exhaust disk | Fills `/job/out` and `/tmp`. | **Held.** Both ended in ENOSPC (job disk after 221 MiB, tmpfs after 64 MiB). The job disk file kept its exact size, was never allocated beyond it, and was deleted. |
| 07 ignore cancel | Ignores every catchable signal and spins (cancel at 10 s); the same job cancelled at 0 s, while the VM is still starting and the framework does not yet allow a stop; and a guest that never answers (deadline 15 s). | **Held.** The host force-stopped the VM in all three cases, and the framework confirmed each stop (final state `stopped`), with no VM process left. |
| 08 malformed mesh | Boots `hostile-guest.c` as a fully compromised inspection guest and sends one hostile answer per case. | **Held.** All 11 rejected: NaN, infinite, and 1e300 coordinates, an out-of-range index, a 2³¹ vertex count, zero bodies, trailing bytes, a 4 GiB frame, a path-like tag, a duplicate frame, and a frame wrong for the role. A valid control mesh from the same guest was accepted. |
| 09 inspector tamper | A generation job writes the inspector and its bytecode and plants a forged `mesh.bin` and verdict; separately, one byte of `rootfs.img` or `Image` is changed in a copy of the runtime. | **Held.** Both in-guest writes blocked; inspection returned the honest 10 mm cube, closed; pinned files unchanged. Both tampered runtimes were refused before any VM booted. |

A crafted STEP that makes the re-exported STEP differ from the mesh is covered two ways. The inspector tessellates the same in-memory shapes it re-exports, so an honest inspector cannot produce a mesh of different geometry. Test 08 models the case where a crafted STEP fully compromises the inspection guest, and the host rejects or bounds everything that guest can send.

Two test assertions were corrected during the work. Both were wrong expectations in the harness, not breaches:
- **Test 01.** The scan first read `/dev/zero` until the memory cap stopped it; it now reads regular files only. It also first "found" its own search string in `/job/in/job.json`; the needle is now built at run time.
- **Test 03.** It first expected `env={}` and saw `{'LC_CTYPE': 'C.UTF-8'}`. The agent execs the job with an empty environment, and CPython's own PEP 538 locale coercion then sets that variable inside the interpreter. The test now accepts exactly that.

## Risks the spike must answer

**1. Notarization and a quarantined DMG on macOS 13.0.** Not answered; see the stop-line facts and gates G1 and G2.

**2. Time and memory for two guest boots plus a build on the least capable Mac.** Measured on the M4: 6.6 s and about 1.24 GB resident per running guest. Estimated on an M1: about 10 to 11 s. See Measurements.

**3. Can CI boot the guest?** GitHub-hosted macOS runners cannot. They are themselves Virtualization-framework VMs, and GitHub's docs say "Nested-virtualization is not supported due to the limitation of Apple's Virtualization Framework" ([larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners), [community discussion #69211](https://github.com/orgs/community/discussions/69211)). The SDK headers agree: no nested virtualization for macOS guests. The restriction tests therefore need the self-hosted Mac mini, as `design.md` already plans. The amd64 rootfs builds from the same lock and Dockerfile for the x86_64 Linux runner; its kernel and microVM backend are PR 6's.

**4. Does cadquery-ocp publish Linux arm64 builds at a pinnable version?** Yes, so OpenCascade needs no source build. build123d 0.13.0 resolves to `cadquery-ocp-novtk==8.0.1.0.0`, which has `manylinux_2_28_aarch64` wheels for cp311 to cp314, and VTK drops out entirely. On aarch64, build123d's markers select `py-lib3mf==2.5.0` instead of `lib3mf`, and every wheel in the tree is binary. The lock files (`cad-runtime/lock/requirements-{arm64,amd64}.txt`) come from `uv pip compile requirements.in --python-version 3.13 --python-platform aarch64-manylinux_2_28 --only-binary :all: --generate-hashes` and its x86_64 twin. OCP links `libGL.so.1`, `libX11.so.6`, and `libexpat.so.1` without rendering, so the image adds `libgl1` (glvnd only, no Mesa), `libx11-6`, and `libexpat1`.

**5. Does a STEP member inside the 3MF change slicing or the `handoff.*` checks?** No difference beyond Bambu Studio's own variation. The test sliced a real app-built sign package (from the 0.1.0 release verification) with Bambu Studio 02.08.02.61 on aojdevlinux, using the app's exact arguments: three times as is, twice with the normalized STEP at `Metadata/part.step`, and once at `3D/part.step` (`cad-host/spike/step-in-3mf.sh`; log `cad-runtime/evidence/step-in-3mf.log`).
- **Identical across all six:** success, no plate warning, 13 layers, filament 9.98 / 0.69 / 0.61 g, 6 tool changes, and the same effective-settings hash.
- **Different in every run:** the G-code bytes, including between identical inputs. Bambu Studio's output is not byte-deterministic.

The only `handoff.*` check, `handoff.settings_match_slice`, compares the package's embedded settings with those effective settings, so the STEP member cannot move it. Not tested: opening the package in the Bambu Studio GUI, and whether re-saving a project there keeps the member. The package's `[Content_Types].xml` has no entry for `.step`; PR 3 should add one.

**6. Does snapping the tessellation to the 1 µm grid create degenerate triangles?** Rarely, and the open meshes seen here were not caused by it. Across 13 bodies and 28,454 triangles (the hobbyist set plus both clips), snapping turned 2 triangles into zero-area ones, both in one body: the extruded text of the keychain tag, 2 of its 1,668 triangles. In OpenCascade's raw f64 output those two had nonzero area, so snapping made them degenerate. That same body was already open with 132 open edges when welding only bit-identical f64 points, so the text solid itself is open. The inspector places every edge node on the shared edge curve and every edge end on the shared vertex; the largest correction it made was 0.000000 mm on every part here, so faces already agreed on shared edges. For PR 7: `non_degenerate` can fail on real text, so either re-mesh slivers or report the failure with a message the model can act on.

**7. Does Rig `=0.42.0` carry images in tool results to Anthropic and OpenAI?** Yes for both, from the crate source (`rig-core-0.42.0`). `message::ToolResultContent` has an `Image` variant.
- **Anthropic** (`providers/anthropic/completion.rs`, about line 1187) converts it to a tool-result image block and requires base64 data with a media type.
- **OpenAI** depends on the API. The Responses API (`providers/openai/responses_api/mod.rs`, about line 366) converts it to `input_image`. Chat Completions (`providers/openai/completion/mod.rs`, about line 612) returns "OpenAI Chat Completions does not support images in tool results". The app builds its agent with `openai::Client::new(..).agent(model)` (`src-tauri/src/agent/turn.rs:102`), and Rig 0.42's OpenAI client defaults to the Responses API (`providers/openai/client.rs:77`), so the app's path supports it.

This is source evidence only; no live API call was made.

**8. First-try failure rate for model-written build123d, and `MAX_TURNS`.** This is a proxy measurement: ten hobbyist objects that Claude Opus 5.5 wrote cold in one pass and ran once each, unedited (`cad-host/spike/hobbyist/`, log `cad-runtime/evidence/hobbyist.log`). **8 of 10 succeeded on the first try**, every body closed, non-degenerate, and outward.
- The bottle cap failed with a bounded, repairable error: "line 10: RuntimeError: BuildPart doesn't have a Helix object or operation (Helix applies to ['BuildLine'])".
- The keychain tag built, but its text body is open (see item 6).

Each failure needs at least one repair build. Allowing for one clarifying question, the build, and two repairs, the current `MAX_TURNS` of 8 looks sufficient for single parts. The in-app model with its system prompt was not measured.

## Not proven here
- Notarization of the helper (G2) and any run on macOS 13.0 itself (G1).
- An amd64 kernel and the Linux microVM test backend (PR 6).
- **Build reproducibility.** The image is not bit-reproducible yet. A `--no-cache` rebuild of the arm64 rootfs on the same box, 20 minutes later, gave `rootfs.img` sha256 `cdba943e…` against the pinned `6ed9ccde…`. Diffing the two trees shows 6,333 differing files: 6,330 `.pyc` files under `/usr/local/lib` (CPython's marshal output is not stable across runs, especially under parallel `compileall`) and `/var/log/dpkg.log`, `/var/log/apt/history.log`, and `/var/log/apt/term.log`. Every source file, wheel, and shared library matched. The restriction-test initramfs also differs between builds, because `cpio` records each file's mtime and the init binary is recompiled on every run. Debian packages also come from the live archive, not a snapshot.
- Timing on an M1.
- A live Anthropic or OpenAI call carrying a view image.
- Bambu Studio GUI behavior with a STEP member.

## Follow-ups

**For PR 6:**
- Build the runtime in CI with `cad-runtime/build.sh`.
- Make the image bit-reproducible: compile bytecode deterministically (single-threaded `compileall`, or build the `.pyc` files in one pass and verify them twice), delete `/var/log/apt` and `/var/log/dpkg.log` in the image, clamp the initramfs files' mtimes before `cpio`, pin Debian packages to snapshot.debian.org, and verify the kernel tarball's PGP signature, not only its sha256.
- Add the amd64 kernel and the microVM backend.
- Use the macOS 13.0 bundle at `~/m3d-scratch/pr5-macos13/` for the quarantined-DMG Gatekeeper test.
- Sign the helper with the app's Developer ID inside the bundle once G2 clears.

**For PR 7:**
- Grow `cad_worker.rs` from `cad-host/src/{frame,mesh,manifest}.rs`, and compile the pins into the app instead of reading `pins.json`.
- Verify digests once per launch instead of per build.
- Keep tessellation at 0.02 mm (part of the build key).
- Add a self-interference check (`BOPAlgo_ArgumentAnalyzer`) to the inspector so a self-intersecting script gets a repairable error instead of "mesh not closed".
- Carry body names through STEP (XCAF) rather than by order.
- Make `RawBody`'s fields private or validate in `weld` and `analyze`: built by hand with an out-of-range index or a non-finite coordinate, they can panic (`decode_mesh` is the only safe constructor today).
- Refuse zero-width and bidirectional-control characters in manifest body names, not only control characters.
- Close the console pipe's write end in `run_guest` when `configure` fails after `pipe()`; today that descriptor leaks.

## Reproduce

```bash
# aojdevlinux: library tests and the image
cd cad-host && cargo test --locked
cad-runtime/build.sh arm64            # outputs in cad-runtime/out/arm64/, digests in pins.json
# Mac mini: copy cad-host/ and cad-runtime/out/arm64/ to ~/m3d-scratch/pr5-worker-spike/{cad-host,runtime}/, then
cd cad-host && cargo build --release --locked
codesign -s - -f --options runtime --entitlements entitlements.plist target/release/materialize-cad-host
export HELPER=$PWD/target/release/materialize-cad-host RUNTIME=$PWD/../runtime
$HELPER build --runtime $RUNTIME --source spike/cable-clip-fillet-first.py --params spike/cable-clip.params.json --out out/clip
restriction-tests/run-all.sh out/restriction-tests.log
spike/measure.sh out/measurements.log
spike/run-hobbyist.sh out/hobbyist.log
```

Exit codes from the helper: 0 accepted, 1 the job failed with a bounded error, 2 the guest's output was rejected, 3 deadline or cancel, 4 runtime verification failed.
