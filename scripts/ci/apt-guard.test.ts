import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Linux and mobile jobs share one runner host, so two of them can run apt at the same moment. A direct apt call
// fails at once on the lock (#372). scripts/ci/install-tauri-libs.sh waits for the locks, so it is the only caller.
const root = join(import.meta.dir, "../..");
const installer = "scripts/ci/install-tauri-libs.sh";
// apt or apt-get as a word, quoted or not.
const aptCall = /\bapt(-get)?\b(?!-)/;

const files = (dir: string, name: RegExp) =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => name.test(file))
    .map((file) => join(dir, file));

/** Every `run:` script in a workflow or composite action. Step names, `if:` lines, and YAML comments are not commands. */
const runScripts = (node: unknown): string[] =>
  Array.isArray(node)
    ? node.flatMap(runScripts)
    : typeof node === "object" && node !== null
      ? Object.entries(node).flatMap(([key, value]) =>
          key === "run" && typeof value === "string" ? [value] : runScripts(value),
        )
      : [];

const scripts = [
  ...[".github/workflows", ".github/actions"]
    .flatMap((dir) => files(dir, /\.ya?ml$/))
    .flatMap((path) => runScripts(Bun.YAML.parse(readFileSync(join(root, path), "utf8"))).map((text) => ({ path, text }))),
  ...files("scripts/ci", /\.sh$/)
    .filter((path) => path !== installer)
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") })),
];

test(`CI runs apt only through ${installer}`, () => {
  // A whole-line shell comment is skipped. A # later in a line may sit inside quotes, so the line is checked whole.
  const offenders = scripts.flatMap(({ path, text }) =>
    text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#") && aptCall.test(line))
      .map((line) => `${path}: ${line.trim()}`),
  );
  expect(offenders).toEqual([]);
});
