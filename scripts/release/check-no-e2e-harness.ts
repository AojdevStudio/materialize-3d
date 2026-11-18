#!/usr/bin/env bun
/**
 * Fails when a build carries the e2e verification harness or the scripted file dialog.
 *
 *   bun scripts/release/check-no-e2e-harness.ts              the frontend build in dist/
 *   bun scripts/release/check-no-e2e-harness.ts <app>        also both executables in <app>, a macOS app bundle
 *
 * CI and scripts/release/build-macos.sh both run it. The names come from the source on every run: each `M3D_E2E_*`
 * variable the Rust code reads, behind the `e2e` feature or `debug_assertions`, and each `__M3D_E2E_*__` global the
 * frontend reads. A new name is refused without an edit here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "../..");

function filesIn(dir: string, extension = /$/): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extension.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function namesIn(files: readonly string[], pattern: RegExp): string[] {
  const names = new Set(files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(pattern)].map((match) => match[1] ?? match[0])));
  return [...names].sort();
}

/** `(?<!\w)` keeps a frontend global such as `__M3D_E2E_DIALOGS__` out of the native list. */
const nativeNames = namesIn(filesIn("src-tauri/src", /\.rs$/), /(?<!\w)(M3D_E2E_[A-Z0-9_]*[A-Z0-9])/g);
const frontendNames = namesIn(filesIn("src", /\.tsx?$/), /(__M3D_E2E_[A-Z0-9_]+__)/g);
if (nativeNames.length === 0 || frontendNames.length === 0) {
  throw new Error("no M3D_E2E names found in src-tauri/src or src, so this check would pass anything");
}

const problems: string[] = [];
const holding = (file: string, names: readonly string[]) => {
  const bytes = readFileSync(file);
  return names.filter((name) => bytes.includes(name));
};

for (const file of filesIn("dist")) {
  for (const name of holding(file, frontendNames)) problems.push(`${file} holds ${name}, the scripted file dialog`);
}

const app = process.argv[2];
if (app !== undefined) {
  const conf = readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8");
  const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const mainBinary = /^\[package\]\nname = "([^"]+)"/m.exec(cargo)?.[1];
  const sidecar = /"externalBin": \["([^"]+)"\]/.exec(conf)?.[1];
  if (mainBinary === undefined || sidecar === undefined) throw new Error("cannot read the binary names from Cargo.toml and tauri.conf.json");
  for (const exe of [mainBinary, basename(sidecar)]) {
    const path = join(app, "Contents/MacOS", exe);
    for (const name of holding(path, nativeNames)) problems.push(`${path} holds ${name}, the e2e harness`);
  }
}

for (const problem of problems) console.error(`e2e harness: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`e2e harness: none of ${[...nativeNames, ...frontendNames].join(", ")} in the build`);
