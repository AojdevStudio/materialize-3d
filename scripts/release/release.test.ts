import { describe, expect, test } from "bun:test";
import { updateNotes } from "./latest-json";
import { check, checkPublished, type Published, readRepo, type Read } from "./release-facts";

const changing = (file: string, from: string | RegExp, to: string): Read => (path) => {
  const text = readRepo(path);
  return path === file ? text.replace(from, to) : text;
};

/** Today's value of each fact, so a real version bump or Bambu Studio upgrade leaves these tests green. */
const today = (file: string, pattern: RegExp) => {
  const value = pattern.exec(readRepo(file))?.[1];
  if (value === undefined) throw new Error(`${file} does not match ${pattern}`);
  return value;
};
const version = today("package.json", /"version": "([^"]+)"/);
const bambu = today("src-tauri/src/bambu/studio.rs", /VALIDATED_VERSIONS: &\[&str\] = &\["([^"]+)"\]/);
const bun = today(".github/actions/setup-bun/action.yml", /bun-version: "([^"]+)"/);
const macos = today("src-tauri/tauri.conf.json", /"minimumSystemVersion": "([^"]+)"/);
const identifier = today("src-tauri/tauri.conf.json", /"identifier": "([^"]+)"/);
const siteVersion = today("site/src/release.ts", /^const version = "([^"]+)";$/m);
const siteBambu = today("site/src/release.ts", /^const bambuStudio = "([^"]+)";$/m);
const siteMacOS = today("site/src/release.ts", /minimumMacOS: "([^"]+)"/);

/** A Latest release that matches the site, built from source that names the site's Bambu build and minimum macOS. */
const published = (tagSource: { bambu?: string; macos?: string } = {}, tag = `v${siteVersion}`): Published => ({
  tag,
  assets: ["latest.json", `Materialize-3D-${siteVersion}-macos-arm64.dmg`],
  atTag: (file) =>
    ({
      "src-tauri/src/bambu/studio.rs": `pub const VALIDATED_VERSIONS: &[&str] = &["${tagSource.bambu ?? siteBambu}"];`,
      "src-tauri/tauri.conf.json": `"minimumSystemVersion": "${tagSource.macos ?? siteMacOS}"`,
    })[file] ?? "",
});

describe("release facts", () => {
  test("every copy in the tree matches its source", () => {
    expect(check(readRepo)).toEqual([]);
  });

  test.each([
    ["site/index.html", bambu, "99.99.99.99", "Bambu Studio build: site/index.html says 99.99.99.99"],
    ["src-tauri/Cargo.toml", `version = "${version}"`, 'version = "99.0.0"', "app version: src-tauri/Cargo.toml says 99.0.0"],
    ["docs/install-macos.md", `macOS ${macos} or later`, "macOS 99.0 or later", "minimum macOS: docs/install-macos.md says 99.0"],
    ["sidecar/package.json", `"@types/bun": "${bun}"`, '"@types/bun": "99.0.0"', "Bun version: sidecar/package.json says 99.0.0"],
    ["docs/install-macos.md", identifier, `${identifier}.other`, `bundle id: docs/install-macos.md says ${identifier}.other`],
    ["site/src/release.ts", "-macos-arm64.dmg`", "-macos-arm64.dmg.zip`", "site DMG: site/src/release.ts links"],
    ["site/src/release.ts", "/download/v${version}/", "/download/${version}/", "site DMG: site/src/release.ts links"],
    ["site/src/release.ts", /^const version = "[^"]+";$/m, 'const version = "99.0.0";', `site version: site/src/release.ts offers 99.0.0, newer than package.json ${version}`],
    ["src-tauri/tauri.conf.json", '"version": "../package.json"', `"version": "${version}"`, `tauri.conf.json sets "${version}"`],
  ] as const)("a changed copy in %s fails", (file, from, to, problem) => {
    const problems = check(changing(file, from, to));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
  });

  test("the source moves to a new Bambu build and minimum macOS while the site still offers the published release", () => {
    const next = (text: string) =>
      text
        .replaceAll(bambu, "02.08.02.62")
        .replaceAll(`macOS ${macos} or later`, "macOS 27.0 or later")
        .replace(`"minimumSystemVersion": "${macos}"`, '"minimumSystemVersion": "27.0"')
        .replace(`--minimum-deployment-target ${macos}`, "--minimum-deployment-target 27.0");
    expect(check((path) => (path.startsWith("site/") ? readRepo(path) : next(readRepo(path))))).toEqual([]);
  });

  test("the site describes the Latest release and the source at its tag", () => {
    expect(checkPublished(readRepo, published())).toEqual([]);
  });

  test.each([
    ["the tag validates another Bambu build", readRepo, published({ bambu: "99.99.99.99" }), "site Bambu Studio build: site/src/release.ts says"],
    ["the tag needs a newer macOS", readRepo, published({ macos: "99.0" }), "site minimum macOS: site/src/release.ts says"],
    ["the site links a DMG the release lacks", changing("site/src/release.ts", "-macos-arm64.dmg", "-mac.dmg"), published(), "site DMG: site/src/release.ts links"],
    ["a newer release is Latest", readRepo, published({}, "v99.0.0"), "site version: site/src/release.ts offers"],
  ] as const)("--published fails when %s", (_, read, latest, problem) => {
    const problems = checkPublished(read, latest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
  });

  test("a copy the pattern no longer finds fails", () => {
    expect(check(changing("site/README.md", "`BUN_VERSION` =", "`BUN` ="))).toEqual([
      "Bun version: site/README.md no longer names it. Update its pattern in scripts/release/release-facts.ts.",
    ]);
  });
});

describe("update banner notes", () => {
  const changes = (version: string) => `What changed: https://github.com/AojdevStudio/materialize-3d/releases/tag/v${version}`;
  const fromOldApp =
    "The sign, part, printer, and MakerWorld screens, the MCP server, and the OpenAI API key path are gone, and the app no longer sends jobs to a printer. Choose Later to keep 0.2.2.";

  test("0.3.0 introduces the chat studio", () => {
    expect(updateNotes("0.3.0")).toBe(`Materialize 3D 0.3.0 is a new chat studio. ${fromOldApp}\n${changes("0.3.0")}`);
  });

  test("a later 0.3 release warns an app still on 0.2.2", () => {
    expect(updateNotes("0.3.5")).toBe(
      `Materialize 3D 0.3.5. Updating from 0.2.2? 0.3 is a new chat studio. ${fromOldApp}\n${changes("0.3.5")}`,
    );
  });

  test("0.4.0 links its changes only", () => {
    expect(updateNotes("0.4.0")).toBe(`Materialize 3D 0.4.0. ${changes("0.4.0")}`);
  });
});
