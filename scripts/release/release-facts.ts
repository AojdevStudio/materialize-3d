#!/usr/bin/env bun
/**
 * Each release fact has one source. This check fails when a copy of it says something else.
 *
 *   bun scripts/release/release-facts.ts              every copy in the tree agrees with its source
 *   bun scripts/release/release-facts.ts --published  also, the site describes the Latest published GitHub release
 *
 * A version bump edits package.json and src-tauri/Cargo.toml, because Cargo cannot read package.json.
 * tauri.conf.json reads its version from package.json.
 *
 * The site describes the published download, so its facts have their own source, site/src/release.ts: the version,
 * the DMG, the Bambu Studio build, and the minimum macOS. They trail the source on main from a change there until
 * the release is published (docs/releasing.md, step 7). The default check compares the site only with itself.
 * --published compares it with the Latest release and with the source at that release's tag.
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
const site = "site/src/release.ts";
const bambuSource = "src-tauri/src/bambu/studio.rs";
const conf = "src-tauri/tauri.conf.json";
const validatedBambu = (read: Read) => sourceValue(read, bambuSource, /VALIDATED_VERSIONS: &\[&str\] = &\["([^"]+)"\];/);
const minimumMacOS = (read: Read) => sourceValue(read, conf, /"minimumSystemVersion": "([^"]+)"/);

function siteRelease(read: Read) {
  return {
    version: sourceValue(read, site, /^const version = "([^"]+)";$/m),
    repoUrl: sourceValue(read, site, /repoUrl: "([^"]+)"/),
    dmgUrl: placeholder(sourceValue(read, site, /dmgUrl: `([^`]+)`/)),
    bambu: sourceValue(read, site, /^const bambuStudio = "([^"]+)";$/m),
    minimumMacOS: sourceValue(read, site, /minimumMacOS: "([^"]+)"/),
  };
}

function facts(read: Read): Fact[] {
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
      value: validatedBambu(read),
      copies: [
        "scripts/ci/install-bambu-linux.sh",
        "scripts/ci/install-bambu-macos.sh",
        "AGENTS.md",
        "docs/install-macos.md",
        "docs/verify-on-mac.md",
        "docs/releasing.md",
        ".agents/skills/verify-materialize-3d/scripts/mac.ts",
        ".agents/skills/verify-materialize-3d/features/README.md",
      ].map((file) => ({ file, pattern: bambuBuild })),
    },
    {
      name: "site Bambu Studio build",
      source: site,
      value: siteRelease(read).bambu,
      copies: [{ file: "site/index.html", pattern: bambuBuild }],
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
      value: minimumMacOS(read),
      copies: [
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
      source: "scripts/release/build-macos.sh",
      value: sourceValue(read, "scripts/release/build-macos.sh", /^name="([^"]+\.dmg)"$/m),
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
  const { version, repoUrl, dmgUrl } = siteRelease(read);
  const download = `${repoUrl}/releases/download/v$version/`;
  if (!dmgUrl.startsWith(download) || !dmgUrl.endsWith(".dmg")) {
    problems.push(`site DMG: ${site} links ${dmgUrl}, not a .dmg on the release it offers, ${download}`);
  }
  const appVersion = sourceValue(read, "package.json", /"version": "([^"]+)"/);
  if (Bun.semver.order(version, appVersion) > 0) {
    problems.push(`site version: ${site} offers ${version}, newer than package.json ${appVersion}`);
  }
  return problems;
}

export type Published = { tag: string; assets: readonly string[]; atTag: Read };

/** The site's facts against the published release: its tag, its files, and the source the tag was built from. */
export function checkPublished(read: Read, latest: Published): string[] {
  const offered = siteRelease(read);
  if (`v${offered.version}` !== latest.tag) {
    return [`site version: ${site} offers v${offered.version}, but the Latest release is ${latest.tag}`];
  }
  const problems: string[] = [];
  const dmg = offered.dmgUrl.slice(offered.dmgUrl.lastIndexOf("/") + 1).replaceAll("$version", offered.version);
  if (!latest.assets.includes(dmg)) {
    problems.push(`site DMG: ${site} links ${dmg}, but ${latest.tag} holds ${latest.assets.join(", ")}`);
  }
  const bambu = validatedBambu(latest.atTag);
  if (offered.bambu !== bambu) {
    problems.push(`site Bambu Studio build: ${site} says ${offered.bambu}, but ${bambuSource} at ${latest.tag} says ${bambu}`);
  }
  const macos = minimumMacOS(latest.atTag);
  if (offered.minimumMacOS !== macos) {
    problems.push(`site minimum macOS: ${site} says ${offered.minimumMacOS}, but ${conf} at ${latest.tag} says ${macos}`);
  }
  return problems;
}

const repo = "AojdevStudio/materialize-3d";

function gh(args: string[]): string {
  const run = Bun.spawnSync(["gh", ...args]);
  if (run.exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

/** The release GitHub marks Latest, and its source read through the GitHub API. */
function latestPublished(): Published {
  const tag = gh(["release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName"]).trim();
  const assets = gh(["release", "view", tag, "--repo", repo, "--json", "assets", "--jq", ".assets[].name"]).trim().split("\n");
  const atTag: Read = (file) => gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${file}?ref=${tag}`]);
  return { tag, assets, atTag };
}

if (import.meta.main) {
  const problems = check(readRepo);
  if (process.argv.includes("--published")) problems.push(...checkPublished(readRepo, latestPublished()));
  for (const problem of problems) console.error(`release facts: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log("release facts: every copy matches its source");
}
