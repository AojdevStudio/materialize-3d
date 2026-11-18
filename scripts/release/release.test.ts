import { describe, expect, test } from "bun:test";
import { updateNotes } from "./latest-json";
import { check, readRepo, type Read } from "./release-facts";

const changing = (file: string, from: string, to: string): Read => (path) => {
  const text = readRepo(path);
  return path === file ? text.replace(from, to) : text;
};

describe("release facts", () => {
  test("every copy in the tree matches its source", () => {
    expect(check(readRepo)).toEqual([]);
  });

  test.each([
    ["site/index.html", "02.08.02.61", "02.08.02.62", "Bambu Studio build: site/index.html says 02.08.02.62"],
    ["src-tauri/Cargo.toml", 'version = "0.3.2"', 'version = "0.3.3"', "app version: src-tauri/Cargo.toml says 0.3.3"],
    ["site/src/App.tsx", "macOS 26.0", "macOS 26.1", "minimum macOS: site/src/App.tsx says 26.1"],
    ["sidecar/package.json", '"@types/bun": "1.4.4"', '"@types/bun": "1.4.5"', "Bun version: sidecar/package.json says 1.4.5"],
    ["docs/install-macos.md", "com.aojdevstudio.materialize3d", "com.aojdevstudio.other", "bundle id: docs/install-macos.md says com.aojdevstudio.other"],
    ["site/src/release.ts", "-macos-arm64.dmg", "-mac.dmg", "DMG file name: site/src/release.ts says Materialize-3D-$version-mac.dmg"],
    ["site/src/release.ts", 'const version = "0.3.2"', 'const version = "0.4.0"', "site version: site/src/release.ts offers 0.4.0, newer than package.json 0.3.2"],
    ["src-tauri/tauri.conf.json", '"version": "../package.json"', '"version": "0.3.2"', 'tauri.conf.json sets "0.3.2"'],
  ])("a changed copy in %s fails", (file, from, to, problem) => {
    const problems = check(changing(file, from, to));
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
