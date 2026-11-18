// Fails when the workflow's trigger paths are not the files models/sources.sha256
// covers, plus this skill and the workflow itself. GitHub runs the workflow only
// for a change to one of those paths, so a covered file missing from the list
// could change without the hash check running.
//   bun .agents/skills/formal-verify-materialize-3d/scripts/check-paths.ts
import { join, relative } from "node:path";

const skill = join(import.meta.dir, "..");
const root = join(skill, "../../..");
const workflow = ".github/workflows/formal-verification.yml";
const sources = join(skill, "models/sources.sha256");

const covered = (await Bun.file(sources).text())
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => line.slice(line.indexOf("  ") + 2));
const expected = new Set([...covered, `${relative(root, skill)}/**`, workflow]);

const parsed: unknown = Bun.YAML.parse(await Bun.file(join(root, workflow)).text());
const triggerPaths = (event: string): string[] => {
  const at = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const paths = at(at(at(parsed, "on"), event), "paths");
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    throw new Error(`${workflow} has no on.${event}.paths list.`);
  }
  return paths;
};

let failed = false;
for (const event of ["pull_request", "push"]) {
  const listed = new Set(triggerPaths(event));
  for (const path of expected.difference(listed)) {
    console.error(`${workflow}: on.${event}.paths is missing ${path}`);
    failed = true;
  }
  for (const path of listed.difference(expected)) {
    console.error(`${workflow}: on.${event}.paths has ${path}, which ${relative(root, sources)} does not cover`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`${workflow} paths match ${relative(root, sources)}.`);
