import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Linux and mobile jobs share one runner host, so two of them can run apt at the same moment. A direct
// apt-get call fails at once on the dpkg lock (#372). scripts/ci/install-tauri-libs.sh waits for the lock instead.
const root = join(import.meta.dir, "../..");
const dirs = [".github/workflows", ".github/actions"];

test("CI installs system packages only through scripts/ci/install-tauri-libs.sh", () => {
  const offenders = dirs
    .flatMap((dir) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" }).map((file) => join(dir, file)))
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .flatMap((line, i) => (/\bapt(-get)?\s/.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
  expect(offenders).toEqual([]);
});
