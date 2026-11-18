#!/usr/bin/env bun
/**
 * Each release fact has one source. This check fails when a copy of it says something else.
 *
 *   bun scripts/release/release-facts.ts              every copy in the tree agrees with its source
 *   bun scripts/release/release-facts.ts --published  also, the site offers the latest published GitHub release
 *
 * A version bump edits package.json and src-tauri/Cargo.toml, because Cargo cannot read package.json.
 * tauri.conf.json reads its version from package.json. The site's version is a separate fact: it names the last
 * published release, so it trails package.json from the version bump until the release is published and checked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Read = (file: string) => string;

/** Every match of `pattern` in `file` is one copy, with the value in group 1. */
type Copy = { file: string; pattern: RegExp; normalize?: (text: string) => string };
type Fact = { name: string; source: string; value: string; copies: readonly Copy[] };

const root = join(import.meta.dir, "../..");
export const readRepo: Read = (file) => readFileSync(join(root, file), "utf8");

function sourceValue(read: Read, file: string, pattern: RegExp): string {
  const value = pattern.exec(read(file))?.[1];
  if (value === undefined) throw new Error(`${file} no longer matches ${pattern}, so the release facts check cannot read it`);
  return value;
}

const bambuBuild = /(\d{2}\.\d{2}\.\d{2}\.\d{2})/g;
const orLater = /macOS (\d+(?:\.\d+)*) or later/g;
/** The docs and the site spell the version placeholder their own way. */
const placeholder = (text: string) => text.replace(/<version>|\$V\b|\$\{version\}/g, "$version");
const dmgSource = "scripts/release/build-macos.sh";
const dmgName = (read: Read) => sourceValue(read, dmgSource, /^name="([^"]+\.dmg)"$/m);

function facts(read: Read): Fact[] {
  const conf = "src-tauri/tauri.conf.json";
  const bambuSource = "src-tauri/src/bambu/studio.rs";
  const bunSource = ".github/actions/setup-bun/action.yml";
  return [
    {
      name: "app version",
      source: "package.json",
      value: sourceValue(read, "package.json", /"version": "([^"]+)"/),
      copies: [
        { file: "src-tauri/Cargo.toml", pattern: /^\[package\]\nname = "materialize-3d"\nversion = "([^"]+)"/gm },
        { file: "src-tauri/Cargo.lock", pattern: /^name = "materialize-3d"\nversion = "([^"]+)"/gm },
      ],
    },
    {
      name: "Bambu Studio build",
      source: bambuSource,
      value: sourceValue(read, bambuSource, /VALIDATED_VERSIONS: &\[&str\] = &\["([^"]+)"\];/),
      copies: [
        "scripts/ci/install-bambu-linux.sh",
        "scripts/ci/install-bambu-macos.sh",
        "site/src/release.ts",
        "site/index.html",
        "AGENTS.md",
        "docs/install-macos.md",
        "docs/verify-on-mac.md",
        "docs/releasing.md",
        ".agents/skills/verify-materialize-3d/scripts/mac.ts",
        ".agents/skills/verify-materialize-3d/features/README.md",
      ].map((file) => ({ file, pattern: bambuBuild })),
    },
    {
      name: "Bun version",
      source: bunSource,
      value: sourceValue(read, bunSource, /bun-version: "([^"]+)"/),
      copies: [
        { file: "sidecar/package.json", pattern: /"@types\/bun": "([^"]+)"/g },
        { file: "site/README.md", pattern: /`BUN_VERSION` = `([^`]+)`/g },
      ],
    },
    {
      name: "minimum macOS",
      source: conf,
      value: sourceValue(read, conf, /"minimumSystemVersion": "([^"]+)"/),
      copies: [
        { file: "site/src/App.tsx", pattern: orLater },
        { file: "docs/install-macos.md", pattern: orLater },
        { file: "docs/verify-on-mac.md", pattern: orLater },
        { file: "docs/releasing.md", pattern: orLater },
        { file: "scripts/build-icons.sh", pattern: /--minimum-deployment-target (\S+)/g },
      ],
    },
    {
      name: "bundle id",
      source: conf,
      value: sourceValue(read, conf, /"identifier": "([^"]+)"/),
      copies: [
        "docs/install-macos.md",
        ".agents/skills/verify-materialize-3d/SKILL.md",
        ".agents/skills/verify-materialize-3d/features/README.md",
        ".agents/skills/verify-materialize-3d/scripts/m3d.sh",
      ].map((file) => ({ file, pattern: /\b(com\.aojdevstudio(?:\.[A-Za-z0-9-]+)+)/g })),
    },
    {
      name: "DMG file name",
      source: dmgSource,
      value: dmgName(read),
      copies: [
        // A label after "#" or "| " is the name the release page shows, not the file name.
        { file: "docs/releasing.md", pattern: /(?<!#|\| )(Materialize-3D-[^\s/`"#]+\.dmg)/g, normalize: placeholder },
        { file: "docs/install-macos.md", pattern: /(Materialize-3D-[^\s/`"#]+\.dmg)/g, normalize: placeholder },
      ],
    },
  ];
}

export function check(read: Read): string[] {
  const problems: string[] = [];
  for (const fact of facts(read)) {
    for (const { file, pattern, normalize = (text: string) => text } of fact.copies) {
      const found = new Set([...read(file).matchAll(pattern)].map((match) => normalize(match[1] ?? match[0])));
      if (found.size === 0) problems.push(`${fact.name}: ${file} no longer names it. Update its pattern in scripts/release/release-facts.ts.`);
      for (const copy of found) {
        if (copy !== fact.value) problems.push(`${fact.name}: ${file} says ${copy}, but ${fact.source} says ${fact.value}`);
      }
    }
  }

  const tauriVersion = sourceValue(read, "src-tauri/tauri.conf.json", /"version": "([^"]+)"/);
  if (tauriVersion !== "../package.json") {
    problems.push(`app version: src-tauri/tauri.conf.json sets "${tauriVersion}" instead of reading "../package.json"`);
  }
  const repoUrl = sourceValue(read, "site/src/release.ts", /repoUrl: "([^"]+)"/);
  const siteDmg = placeholder(sourceValue(read, "site/src/release.ts", /dmgUrl: `([^`]+)`/));
  const releaseDmg = `${repoUrl}/releases/download/v$version/${dmgName(read)}`;
  if (siteDmg !== releaseDmg) {
    problems.push(`DMG file name: site/src/release.ts links ${siteDmg}, but ${dmgSource} uploads ${releaseDmg}`);
  }
  const appVersion = sourceValue(read, "package.json", /"version": "([^"]+)"/);
  const siteVersion = sourceValue(read, "site/src/release.ts", /^const version = "([^"]+)";$/m);
  if (Bun.semver.order(siteVersion, appVersion) > 0) {
    problems.push(`site version: site/src/release.ts offers ${siteVersion}, newer than package.json ${appVersion}`);
  }
  return problems;
}

/** The tag of the release GitHub marks Latest. */
function latestPublished(): string {
  const gh = Bun.spawnSync(["gh", "release", "view", "--repo", "AojdevStudio/materialize-3d", "--json", "tagName", "--jq", ".tagName"]);
  if (gh.exitCode !== 0) throw new Error(`gh release view failed: ${gh.stderr.toString().trim()}`);
  return gh.stdout.toString().trim();
}

if (import.meta.main) {
  const problems = check(readRepo);
  if (process.argv.includes("--published")) {
    const site = `v${sourceValue(readRepo, "site/src/release.ts", /^const version = "([^"]+)";$/m)}`;
    const latest = latestPublished();
    if (site !== latest) problems.push(`site version: site/src/release.ts offers ${site}, but the Latest release is ${latest}`);
  }
  for (const problem of problems) console.error(`release facts: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log("release facts: every copy matches its source");
}
