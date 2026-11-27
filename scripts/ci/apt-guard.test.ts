import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Linux and mobile jobs share one runner host, so two of them can run apt at the same moment. A direct apt call
// fails at once on the lock (#372). scripts/ci/install-tauri-libs.sh waits for the locks, so it is the only caller.
const root = join(import.meta.dir, "../..");
const installer = "scripts/ci/install-tauri-libs.sh";
const scanned: [dir: string, file: RegExp][] = [
  [".github/workflows", /\.ya?ml$/],
  [".github/actions", /\.ya?ml$/],
  ["scripts/ci", /\.sh$/],
];
// apt or apt-get as a word, quoted or not. A comment starts at a # at the line start or after a space.
const aptCall = /\bapt(-get)?\b(?!-)/;
const comment = /(^|\s)#.*$/;

test(`CI runs apt only through ${installer}`, () => {
  const offenders = scanned
    .flatMap(([dir, file]) =>
      readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
        .filter((name) => file.test(name))
        .map((name) => join(dir, name)),
    )
    .filter((path) => path !== installer)
    .flatMap((path) =>
      readFileSync(join(root, path), "utf8")
        .split("\n")
        .flatMap((line, i) => (aptCall.test(line.replace(comment, "")) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
    );
  expect(offenders).toEqual([]);
});
