#!/usr/bin/env bun
/**
 * PreToolUse (Bash) hook: every PR create, edit, and merge goes through the PR kit.
 *
 * - create and edit: the body must pass the contract in contract.ts.
 * - merge: the PR body must pass, and the review bot must have passed the exact head
 *   (land-pr/merge.ts).
 *
 * - graphql: a PR create, update, or merge through `gh api graphql` is refused, and so
 *   is any GraphQL call whose query this gate cannot read.
 *
 * Two installs run this same file. A repo carries it at .claude/skills/open-pr/gate.ts,
 * wired in the repo's .claude/settings.json, so cloud sessions get it. The MacBook also
 * wires ~/.claude/agents-config/kits/pr/open-pr/gate.ts globally. The global copy never
 * stands down: in a repo with its own copy both run, and both check the same contract,
 * so a repo cannot swap in a weaker gate.
 *
 * Exit 0 allows, exit 2 denies with the reason on stderr. A PR write that cannot be
 * checked is denied, never passed. PR_KIT_OFF=1 is Ossie's switch, never an agent's.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { checkPullRequest, formatViolations, titleViolation, type PullRequest } from "./contract";
import { findPrCommands, graphqlRisk, type BodySource, type PrCommand } from "./command";
import { botExempt, decideMerge, PASS_SIGNAL, type CheckRun } from "../land-pr/merge";

interface HookInput {
  tool: string;
  command: string;
  cwd: string;
}

function parseInput(raw: string): HookInput {
  const x: unknown = raw.trim() ? JSON.parse(raw) : {};
  const obj = isObj(x) ? x : {};
  const toolInput = isObj(obj.tool_input) ? obj.tool_input : {};
  return {
    tool: isStr(obj.tool_name) ? obj.tool_name : "",
    command: isStr(toolInput.command) ? toolInput.command : "",
    cwd: isStr(obj.cwd) ? obj.cwd : process.cwd(),
  };
}

class Refusal extends Error {}

function run(argv: string[], cwd: string): string {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: 8_000 });
  if (r.exitCode !== 0) throw new Refusal(`\`${argv.join(" ")}\` failed: ${(r.stderr.toString() || r.stdout.toString()).trim()}`);
  return r.stdout.toString().trim();
}

const ghJson = (path: string, cwd: string): unknown => JSON.parse(run(["gh", "api", path], cwd));

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

function field<T>(obj: unknown, key: string, guard: (v: unknown) => v is T, what: string): T {
  const v = isObj(obj) ? obj[key] : undefined;
  if (!guard(v)) throw new Refusal(`GitHub returned ${what} without a valid "${key}".`);
  return v;
}
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function expand(path: string, cwd: string): string {
  return resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()).replace(/\$\{HOME\}|\$HOME\b/g, homedir()));
}

function readBody(source: BodySource, cmd: PrCommand, cwd: string): string {
  if (source.kind === "inline") return source.text;
  if (source.kind === "missing") throw new Refusal("the command sets no body. Write the body with the open-pr skill and pass it with --body-file.");
  if (cmd.host) throw new Refusal(`the body file ${source.path} is on ${cmd.host}, so this gate cannot read it. Pass the body inline with a heredoc.`);
  if (source.path.startsWith("json:")) {
    const file = expand(source.path.slice(5), cwd);
    if (!existsSync(file)) throw new Refusal(`the --input file ${file} does not exist yet. Write it in an earlier command.`);
    const json: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObj(json) && isStr(json.body) ? json.body : "";
  }
  const file = expand(source.path, cwd);
  if (!existsSync(file)) throw new Refusal(`the body file ${file} does not exist yet. Write it in an earlier command.`);
  return readFileSync(file, "utf8");
}

function contract(pr: PullRequest): void {
  const verdict = checkPullRequest(pr);
  if (!verdict.ok) throw new Refusal(`the PR body breaks the contract:\n${formatViolations(verdict.violations)}`);
}

interface RestPull {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  headSha: string;
  baseSha: string;
  baseRepo: string;
}

function parsePull(x: unknown): RestPull {
  return {
    number: field(x, "number", isNum, "a PR"),
    title: field(x, "title", isStr, "a PR"),
    body: field(x, "body", isStrOrNull, "a PR"),
    draft: field(x, "draft", isBool, "a PR"),
    headSha: field(field(x, "head", isObj, "a PR"), "sha", isStr, "a PR head"),
    baseSha: field(field(x, "base", isObj, "a PR"), "sha", isStr, "a PR base"),
    baseRepo: field(field(field(x, "base", isObj, "a PR"), "repo", isObj, "a PR base"), "full_name", isStr, "a PR base repo"),
  };
}

function parseRun(x: unknown): CheckRun {
  return {
    name: field(x, "name", isStr, "a check-run"),
    status: field(x, "status", isStr, "a check-run"),
    conclusion: field(x, "conclusion", isStrOrNull, "a check-run"),
  };
}

function resolvePull(cmd: Extract<PrCommand, { kind: "merge" }>, cwd: string): { repo: string; pull: RestPull } {
  const url = cmd.target?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  let repo = url?.[1] ?? cmd.repo;
  if (!repo) {
    if (cmd.host) throw new Refusal(`a merge over ssh on ${cmd.host} must name the repo with --repo owner/name, so the gate can check it.`);
    repo = run(["gh", "api", "repos/{owner}/{repo}", "--jq", ".full_name"], cwd);
  }
  const number = url?.[2] ?? (cmd.target && /^#?\d+$/.test(cmd.target) ? cmd.target.replace("#", "") : undefined);
  if (number) return { repo, pull: parsePull(ghJson(`repos/${repo}/pulls/${number}`, cwd)) };
  if (cmd.host && !cmd.target) throw new Refusal(`a merge over ssh on ${cmd.host} must name the PR number.`);
  const branch = cmd.target ?? run(["git", "branch", "--show-current"], cwd);
  const owner = repo.split("/")[0];
  const open = ghJson(`repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`, cwd);
  if (!isArr(open) || open.length === 0) throw new Refusal(`no open PR in ${repo} has head branch ${branch}.`);
  return { repo, pull: parsePull(open[0]) };
}

function latestRuns(repo: string, sha: string, cwd: string): CheckRun[] {
  const page = ghJson(`repos/${repo}/commits/${sha}/check-runs?check_name=${PASS_SIGNAL}&filter=latest`, cwd);
  return field(page, "check_runs", isArr, "a check-run list").map(parseRun);
}

const UNREADABLE = "this gate cannot read the GraphQL query, so it cannot prove the call neither writes nor merges a PR. Pass the query as a literal with values as GraphQL variables (`-F name=value`), or use `gh pr` or the REST pulls endpoint.";

/** The GraphQL text of a `graphql` command, or null when this gate cannot read it. */
function graphqlText(cmd: Extract<PrCommand, { kind: "graphql" }>, cwd: string): string | null {
  const { query } = cmd;
  if (query.kind === "missing" || (query.kind === "file" && cmd.host)) return null;
  const file = query.kind === "file" ? expand(query.path, cwd) : null;
  if (file !== null && !existsSync(file)) return null;
  const raw = file === null ? (query.kind === "inline" ? query.text : "") : readFileSync(file, "utf8");
  if (!cmd.json) return raw;
  try {
    const json: unknown = JSON.parse(raw);
    return isObj(json) && isStr(json.query) ? json.query : null;
  } catch {
    return null;
  }
}

function checkGraphql(cmd: Extract<PrCommand, { kind: "graphql" }>, cwd: string): void {
  const text = graphqlText(cmd, cwd);
  // A JSON request can carry its own operationName, and an unquoted heredoc expands `$`.
  const risk = text === null ? "opaque" : graphqlRisk(text, cmd.operationName || cmd.json);
  if (risk === "merge") throw new Refusal("a GraphQL merge skips the policy check. Merge with `gh pr merge <n>` or the REST merge endpoint.");
  if (risk === "write") throw new Refusal("a GraphQL createPullRequest or updatePullRequest skips the body contract. Use `gh pr create` or `gh pr edit`, or the REST pulls endpoint (`gh api repos/{owner}/{repo}/pulls`).");
  if (risk === "opaque") throw new Refusal(UNREADABLE);
}

function checkMerge(cmd: Extract<PrCommand, { kind: "merge" }>, cwd: string): void {
  const { repo, pull } = resolvePull(cmd, cwd);
  contract({ title: pull.title, body: pull.body ?? "", draft: pull.draft });
  const sha = pull.headSha;
  if (botExempt(pull.baseRepo) && cmd.pinned) return;
  const commit = ghJson(`repos/${repo}/commits/${sha}`, cwd);
  const parents = field(commit, "parents", isArr, "a commit").map((p) => field(p, "sha", isStr, "a commit parent"));
  const runs = latestRuns(repo, sha, cwd);
  const mergeCommit = parents.length === 2 && !runs.some((r) => r.conclusion === "success");
  const parentRuns = mergeCommit ? latestRuns(repo, parents[0], cwd) : undefined;
  const compare = mergeCommit ? ghJson(`repos/${repo}/compare/${parents[1]}...${pull.baseSha}`, cwd) : undefined;
  const mergesBase = compare === undefined ? undefined : ["identical", "ahead"].includes(field(compare, "status", isStr, "a compare"));
  const verdict = decideMerge({ repo: pull.baseRepo, pinned: cmd.pinned, sha, parents, runs, parentRuns, mergesBase });
  if (!verdict.ok) throw new Refusal(`${repo}#${pull.number} cannot merge: ${verdict.reason} Follow the land-pr skill.`);
}

function check(cmd: PrCommand, hookCwd: string): void {
  const cwd = cmd.host ? hookCwd : expand(cmd.dir ?? ".", hookCwd);
  if (cmd.kind === "merge") return checkMerge(cmd, cwd);
  if (cmd.kind === "graphql") return checkGraphql(cmd, cwd);
  if (cmd.kind === "create") return contract({ title: cmd.title, draft: cmd.draft, body: readBody(cmd.body, cmd, cwd) });
  if (cmd.body) return contract({ title: cmd.title, body: readBody(cmd.body, cmd, cwd) });
  const title = cmd.title === undefined ? null : titleViolation(cmd.title);
  if (title) throw new Refusal(`the PR title breaks the contract:\n${formatViolations([title])}`);
}

const input = parseInput(await new Response(Bun.stdin.stream()).text());
if (process.env.PR_KIT_OFF === "1" || input.tool !== "Bash") process.exit(0);
const commands = findPrCommands(input.command);
if (commands.length === 0) process.exit(0);
const cwd = input.cwd;

for (const cmd of commands) {
  try {
    check(cmd, cwd);
  } catch (err) {
    const reason = err instanceof Refusal ? err.message : `the gate could not check this command: ${String(err)}`;
    process.stderr.write(`PR kit blocked \`${cmd.via}\`.\n${reason}\nThe open-pr and land-pr skills write and land a PR that passes.\n`);
    process.exit(2);
  }
}
process.exit(0);
