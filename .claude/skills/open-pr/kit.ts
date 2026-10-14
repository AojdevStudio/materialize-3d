#!/usr/bin/env bun
/**
 * Installs the PR kit into a repo, so every agent that opens the repo carries it,
 * cloud sessions included. Run it again to update; a second run changes nothing.
 *
 *   bun kit.ts install <repo> [--runs-on <label>]
 *
 * The sources sit next to this file: `open-pr` is its folder and `land-pr` is the sibling.
 * That holds in the kit's source folder, the fleet store, and an installed repo's
 * .claude/skills, so any copy can install the kit into another repo.
 *
 * Writes, inside <repo>:
 *   .claude/skills/open-pr, .claude/skills/land-pr   the skills, gate, and checker
 *   .agents/skills/{open-pr,land-pr}                  symlinks for Codex and Cursor
 *   .claude/settings.json                             the PreToolUse gate hook
 *   .github/workflows/pr-kit.yml                      the PR body check in CI
 *   AGENTS.md (and CLAUDE.md when it does not load AGENTS.md)  the rule block
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const SKILLS = ["open-pr", "land-pr"] as const;
const SOURCE = { "open-pr": import.meta.dir, "land-pr": join(import.meta.dir, "..", "land-pr") } satisfies Record<(typeof SKILLS)[number], string>;
const MARKER = ".pr-kit";
const HOOK = 'bun "$CLAUDE_PROJECT_DIR/.claude/skills/open-pr/gate.ts"';
const BLOCK_START = "<!-- pr-kit:start -->";
const BLOCK_END = "<!-- pr-kit:end -->";
const BLOCK = `${BLOCK_START}
## Pull requests

- Open every PR with the \`open-pr\` skill and land it with the \`land-pr\` skill. Both live in \`.claude/skills/\`.
- The PR body has five fixed sections: Problem, Change, Proof, Review, Merge danger. Merge danger names the door and the blast radius.
- The open-pr gate and the \`pr-kit\` CI check refuse a body that breaks the contract. Fix the body. Never route around either.
${BLOCK_END}`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "runs-on": { type: "string" } } });
const [verb, target] = positionals;
if (verb !== "install" || !target) {
  console.error("usage: bun kit.ts install <repo> [--runs-on <label>]");
  process.exit(1);
}
const repo = target.replace(/\/+$/, "");
if (!existsSync(join(repo, ".git"))) throw new Error(`${repo} is not a git checkout`);

const changes: string[] = [];
const note = (what: string) => changes.push(what);

function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  note(`wrote ${relative(repo, path)}`);
}

function copySkill(name: (typeof SKILLS)[number]): void {
  const dest = join(repo, ".claude", "skills", name);
  if (existsSync(dest) && !existsSync(join(dest, MARKER))) {
    throw new Error(`${relative(repo, dest)} exists and is not the PR kit. Move it, then rerun.`);
  }
  const src = SOURCE[name];
  if (!existsSync(join(src, "SKILL.md"))) throw new Error(`${src} is not the ${name} skill. Run kit.ts from a full copy of the kit.`);
  const shipped = readdirSync(src).filter((f) => !f.startsWith(".") && !f.endsWith(".test.ts") && statSync(join(src, f)).isFile());
  for (const file of shipped) writeIfChanged(join(dest, file), readFileSync(join(src, file), "utf8"));
  for (const file of existsSync(dest) ? readdirSync(dest) : []) {
    if (file === MARKER || shipped.includes(file)) continue;
    rmSync(join(dest, file), { recursive: true });
    note(`removed ${relative(repo, join(dest, file))}`);
  }
  writeIfChanged(join(dest, MARKER), "Installed by the PR kit (open-pr/kit.ts). Edit the kit at its source, not here.\n");
}

function linkSkill(name: string): void {
  const link = join(repo, ".agents", "skills", name);
  const to = join("..", "..", ".claude", "skills", name);
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === to) return;
    console.warn(`skip ${relative(repo, link)}: it exists and is not the kit link`);
    return;
  }
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(to, link);
  note(`linked ${relative(repo, link)}`);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The gate hook's settings. 120 seconds covers a merge check's chain of `gh` calls (8 seconds
 * each). `onFailure: "block"` makes a gate that times out, fails to start, or crashes deny
 * the call, since Claude Code otherwise lets it run.
 */
const HOOK_SETTINGS = { timeout: 120, onFailure: "block" } as const;

/** Wires the gate hook, and brings an entry from an earlier install up to HOOK_SETTINGS. */
function wireHook(): void {
  const path = join(repo, ".claude", "settings.json");
  const settings: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!isObj(settings)) throw new Error(`${relative(repo, path)} is not a JSON object`);
  const hooks = isObj(settings.hooks) ? settings.hooks : {};
  const pre: unknown[] = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const ours = pre.flatMap((m) => (isObj(m) && Array.isArray(m.hooks) ? m.hooks.filter((h): h is Record<string, unknown> => isObj(h) && h.command === HOOK) : []));
  const stale = ours.filter((h) => Object.entries(HOOK_SETTINGS).some(([k, v]) => h[k] !== v));
  if (ours.length > 0 && stale.length === 0) return;
  for (const h of stale) Object.assign(h, HOOK_SETTINGS);
  if (ours.length === 0) pre.push({ matcher: "Bash", hooks: [{ type: "command", command: HOOK, ...HOOK_SETTINGS }] });
  hooks.PreToolUse = pre;
  settings.hooks = hooks;
  writeIfChanged(path, JSON.stringify(settings, null, 2) + "\n");
}

const RUNS_ON = /^\s*runs-on:\s*(\S.*?)\s*$/gm;

/**
 * The runner label: the flag, else the label the installed pr-kit.yml already uses, else the
 * one label most of the repo's other workflows use. Inference never picks a paid hosted
 * label, and a tie for most used is refused, so the result never depends on file order.
 */
function runnerLabel(): string {
  if (values["runs-on"]) return values["runs-on"];
  const dir = join(repo, ".github", "workflows");
  const installed = join(dir, "pr-kit.yml");
  if (existsSync(installed)) {
    const label = [...readFileSync(installed, "utf8").matchAll(RUNS_ON)][0]?.[1];
    if (!label) throw new Error(`${relative(repo, installed)} has no single-line runs-on label. Pass --runs-on <label>.`);
    return label;
  }
  const counts = new Map<string, number>();
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(RUNS_ON)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  const best = [...counts].filter(([, n]) => n === top).map(([label]) => label).sort();
  if (best.length !== 1 || /^(ubuntu|macos|windows)-|\$\{\{/.test(best[0])) {
    throw new Error(`no single self-hosted runner label found (most used: ${best.join(", ") || "none"}). Pass --runs-on <label>. Never default to paid hosted minutes.`);
  }
  return best[0];
}

function writeWorkflow(label: string): void {
  const yml = readFileSync(join(SOURCE["open-pr"], "pr-kit.yml"), "utf8").replace("__RUNS_ON__", label);
  writeIfChanged(join(repo, ".github", "workflows", "pr-kit.yml"), yml);
}

function writeBlock(path: string): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const at = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  const next = at >= 0 && end > at
    ? text.slice(0, at) + BLOCK + text.slice(end + BLOCK_END.length)
    : `${text.replace(/\s*$/, text ? "\n\n" : "")}${BLOCK}\n`;
  writeIfChanged(path, next);
}

// Resolve the runner before any write, so a missing label cannot leave a partial install.
const label = runnerLabel();
for (const name of SKILLS) copySkill(name);
for (const name of SKILLS) linkSkill(name);
wireHook();
writeWorkflow(label);
writeBlock(join(repo, "AGENTS.md"));
const claude = join(repo, "CLAUDE.md");
if (existsSync(claude) && !readFileSync(claude, "utf8").includes("AGENTS.md")) writeBlock(claude);

console.log(changes.length ? changes.map((c) => `- ${c}`).join("\n") : "PR kit already current.");
console.log("Next: commit these files in their own PR, then make the pr-kit check required in the repo ruleset.");
