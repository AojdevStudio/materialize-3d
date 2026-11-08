#!/usr/bin/env bun
/**
 * The merge danger that counts for the agent-merge rule: the higher of two ratings, the PR
 * body's Merge danger and the `merge-danger` commit status that open-pr/score.ts posts on the
 * exact head. A blast radius of medium or lower lets the agent merge on its own.
 *
 *   bun danger.ts <owner/repo> <pr-number>
 *
 * Exit 0: the agent may merge. Exit 1: the owner's word. Exit 3: wait for the scorer.
 *
 * - No status, and no scorer for this PR (none on the default branch, or a fork or Dependabot PR
 *   it skips): the body's rating alone counts, as before.
 * - The scorer runs for this PR but has not rated the head, or its newest status is pending: wait.
 *   A score must also match the current base commit and scored title/body. An edit requests a
 *   new score. After a base-branch push, close and reopen the PR to score the new comparison.
 * - The newest status is `error` or `failure`: the owner's word. A later success replaces an
 *   earlier error, so a rerun can rate a head after an outage.
 * - Any workflow's token posts as github-actions[bot], so a rating counts only when its status
 *   links a finished, successful pull_request_target attempt of merge-danger.yml on this exact head.
 *   A PR cannot start such a run with its own code. A merge-danger status from any other account,
 *   or one that links anything else, refuses.
 *   That attempt's own job log must record the current input fingerprint and the status's radius.
 *   A caller-supplied URL hash alone is not evidence. Missing log proof takes the owner's word.
 * The gate never reads this rating, so the rule stays the agent's to keep, as land-pr says.
 */

import { checkPullRequest, type PullRequest } from "../open-pr/contract";
import { inputFingerprint, parseEvent, PROOF_PREFIX, RADII, RATING, STATUS_CONTEXT, type Radius, type ScoreEvidence } from "../open-pr/score";

export type RunProof = ({ kind: "recorded" } & ScoreEvidence) | { kind: "unavailable"; why: string };

/** The commit status fields this reads, as the REST API returns them, newest first. */
export interface Status {
  state: string;
  description: string | null;
  context: string;
  creator: { login: string } | null;
  targetUrl: string | null;
}

/** The workflow run fields this reads, as the REST API returns them. */
export interface ScorerRun {
  path: string;
  event: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  proof: RunProof;
}

/** What readStatus needs besides the statuses: whether the scorer runs for this PR, and its linked attempts, by ID/attempts/number. */
export interface Scorer {
  installed: boolean;
  repo: string;
  head: string;
  inputs: string;
  runs: ReadonlyMap<string, ScorerRun>;
}

export type StatusReading =
  | { kind: "absent" }
  | { kind: "waiting"; why: string }
  | { kind: "refused"; why: string }
  | { kind: "rated"; radius: Radius };

export type Danger = { verdict: "agent" | "owner"; radius: Radius; why: string } | { verdict: "owner" | "wait"; why: string };

const SCORER = "github-actions[bot]";
const SCORER_PATH = ".github/workflows/merge-danger.yml";

/** The run and attempt a status links, when it links a scorer attempt in `repo`. */
export function runAttemptOf(repo: string, url: string | null): string | undefined {
  const prefix = `https://github.com/${repo}/actions/runs/`.toLowerCase();
  return url?.toLowerCase().startsWith(prefix) ? url.slice(prefix.length).match(/^([1-9]\d*\/attempts\/[1-9]\d*)#inputs=[a-f0-9]{64}$/)?.[1] : undefined;
}

/** False when the merge-danger workflow is not on the default branch, or it skips this PR (forks and Dependabot, as its `if:` says). */
export const scorerWillRun = (workflowOnDefault: boolean, pr: { headRepo: string | null; baseRepo: string; author: string | null }): boolean =>
  workflowOnDefault && pr.headRepo === pr.baseRepo && pr.author !== "dependabot[bot]";
const rank = (radius: Radius) => RADII.indexOf(radius);
const isRadius = (word: string | undefined): word is Radius => RADII.some((r) => r === word);

/**
 * The scorer's statuses on the head (newest first), as one reading. Only current inputs count.
 * The newest matching status decides the state, with the highest matching successful rating.
 */
export function readStatus(statuses: readonly Status[], scorer: Scorer): StatusReading {
  const ours = statuses.filter((s) => s.context === STATUS_CONTEXT);
  const stranger = ours.find((s) => s.creator?.login !== SCORER);
  if (stranger) return { kind: "refused", why: `a ${STATUS_CONTEXT} status comes from ${stranger.creator?.login ?? "a deleted account"}, not ${SCORER}` };
  const unlinked = ours.find((s) => s.state === "success" && runAttemptOf(scorer.repo, s.targetUrl) === undefined);
  if (unlinked) return { kind: "refused", why: `a ${STATUS_CONTEXT} status links ${JSON.stringify(unlinked.targetUrl)}, not a run of ${SCORER_PATH} in ${scorer.repo}` };
  if (ours.length === 0) return scorer.installed ? { kind: "waiting", why: "the scorer has not rated this head yet" } : { kind: "absent" };
  const current = ours.filter((s) => s.targetUrl?.endsWith(`#inputs=${scorer.inputs}`));
  const [newest] = current;
  if (newest === undefined) return scorer.installed ? { kind: "waiting", why: "the scorer has not rated the current base, title, and body. Wait for the run a push or edit started. If none is running, close and reopen the PR to request a fresh score" } : { kind: "absent" };
  if (newest.state === "error" || newest.state === "failure") return { kind: "refused", why: `the ${STATUS_CONTEXT} status is ${newest.state}: ${newest.description ?? "no description"}` };
  if (newest.state !== "success") return { kind: "waiting", why: `the ${STATUS_CONTEXT} status is ${newest.state}` };
  let radius: Radius | undefined;
  for (const s of current.filter((s) => s.state === "success")) {
    const id = runAttemptOf(scorer.repo, s.targetUrl);
    const run = id === undefined ? undefined : scorer.runs.get(id);
    if (run === undefined) return { kind: "refused", why: `a ${STATUS_CONTEXT} status links ${JSON.stringify(s.targetUrl)}, not a run of ${SCORER_PATH} in ${scorer.repo}` };
    if (run.path !== SCORER_PATH || run.event !== "pull_request_target" || run.headSha !== scorer.head) {
      return { kind: "refused", why: `a ${STATUS_CONTEXT} status links run ${id}, which is ${run.path} on ${run.event} for ${run.headSha.slice(0, 7)}, not the scorer on this head` };
    }
    if (run.status !== "completed") return { kind: "waiting", why: `scorer run ${id} is ${run.status}` };
    if (run.conclusion !== "success") return { kind: "refused", why: `scorer run ${id} concluded ${run.conclusion}, yet a success status links it` };
    const word = s.description?.match(RATING)?.[1];
    if (!isRadius(word)) return { kind: "refused", why: `the ${STATUS_CONTEXT} status says ${JSON.stringify(s.description)}, which names no blast radius` };
    if (run.proof.kind === "unavailable") return { kind: "refused", why: `scorer run ${id} has no verified output: ${run.proof.why}` };
    if (run.proof.inputs !== scorer.inputs || run.proof.radius !== word) return { kind: "refused", why: `the ${STATUS_CONTEXT} status does not match the inputs and rating recorded by scorer run ${id}` };
    if (radius === undefined || rank(word) > rank(radius)) radius = word;
  }
  return radius === undefined ? { kind: "waiting", why: "the scorer has not rated this head yet" } : { kind: "rated", radius };
}

/** The higher of the body's blast radius word and the scorer's reading, and who may merge. */
export function dangerThatCounts(bodyWord: string | undefined, status: StatusReading): Danger {
  if (status.kind === "waiting") return { verdict: "wait", why: `${status.why}. Wait for its status like a CI check.` };
  if (status.kind === "refused") return { verdict: "owner", why: `${status.why}. The owner decides.` };
  const word = bodyWord?.toLowerCase();
  if (word !== undefined && !isRadius(word)) return { verdict: "owner", why: `the body's blast radius "${bodyWord}" is not one of ${RADII.join(", ")}. The owner decides.` };
  const ratings = [word, status.kind === "rated" ? status.radius : undefined].filter((r) => r !== undefined);
  if (ratings.length === 0) return { verdict: "owner", why: "the PR has no blast radius, from its body or the scorer. The owner decides." };
  const radius = ratings.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const source = status.kind === "rated" ? `the higher of body ${word ?? "none given"} and scorer ${status.radius}` : "the body, since no scorer runs here";
  const verdict = rank(radius) <= rank("medium") ? "agent" : "owner";
  return { verdict, radius, why: `blast radius ${radius}, from ${source}. ${verdict === "agent" ? "The agent may merge on its own." : "The owner decides."}` };
}

/**
 * dangerThatCounts with the body's rating read through the PR contract. A body that breaks the
 * contract takes the owner's word, since the gate refuses its merge and its rating cannot be read.
 */
export function dangerOf(pr: PullRequest, status: StatusReading): Danger {
  const body = checkPullRequest(pr);
  if (!body.ok) return { verdict: "owner", why: `the body breaks the PR contract (${body.violations.map((v) => v.rule).join(", ")}), so its rating cannot be read. Fix the body first.` };
  return dangerThatCounts(body.blastRadius, status);
}

function gh(args: string[]): { ok: true; out: string } | { ok: false; why: string } {
  const r = Bun.spawnSync(["gh", "api", ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? { ok: true, out: r.stdout.toString() } : { ok: false, why: r.stderr.toString().trim() };
}

function ghJson(args: string[]): unknown {
  const r = gh(args);
  if (!r.ok) throw new Error(`gh api ${args.join(" ")} failed: ${r.why}`);
  return JSON.parse(r.out);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" ? x : null);

function parseStatus(x: unknown): Status {
  if (!isObj(x) || typeof x.state !== "string" || typeof x.context !== "string") throw new Error(`GitHub returned a status without state or context: ${JSON.stringify(x)}`);
  const login = isObj(x.creator) ? str(x.creator.login) : null;
  return { state: x.state, context: x.context, description: str(x.description), creator: login === null ? null : { login }, targetUrl: str(x.target_url) };
}

function parseRun(x: unknown): Omit<ScorerRun, "proof"> {
  const [path, event, headSha, status] = isObj(x) ? [str(x.path), str(x.event), str(x.head_sha), str(x.status)] : [];
  if (!isObj(x) || !path || !event || !headSha || !status) throw new Error(`GitHub returned a workflow run without path, event, head_sha, or status: ${JSON.stringify(x)}`);
  return { path, event, headSha, status, conclusion: str(x.conclusion) };
}

/** Accept exactly one well-formed record from a job log, with GitHub's timestamp prefix. */
export function readProof(log: string): RunProof {
  const records = log.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, "")).filter((line) => line.startsWith(PROOF_PREFIX));
  if (records.length !== 1) return { kind: "unavailable", why: `expected one proof record, found ${records.length}` };
  let value: unknown;
  try {
    value = JSON.parse(records[0].slice(PROOF_PREFIX.length));
  } catch {
    return { kind: "unavailable", why: "the proof record is not JSON" };
  }
  const radius = isObj(value) ? str(value.radius) : null;
  if (!isObj(value) || typeof value.inputs !== "string" || !/^[a-f0-9]{64}$/.test(value.inputs) || radius === null || !isRadius(radius)) return { kind: "unavailable", why: "the proof record has invalid inputs or radius" };
  return { kind: "recorded", inputs: value.inputs, radius };
}

/** Job logs are scoped to the linked Actions attempt, never the latest rerun. */
function readRunProof(repo: string, id: string): RunProof {
  const jobs = gh([`repos/${repo}/actions/runs/${id}/jobs?per_page=100`, "--jq", '.jobs[] | select(.name == "Merge danger") | .id']);
  if (!jobs.ok) return { kind: "unavailable", why: jobs.why };
  const job = jobs.out.trim();
  if (!/^\d+$/.test(job)) return { kind: "unavailable", why: `run ${id} has no single Merge danger job` };
  // Capture raw log bytes for the parser, never render terminal control sequences.
  const log = gh([`repos/${repo}/actions/jobs/${job}/logs`, "--allow-escape-sequences"]);
  return log.ok ? readProof(log.out) : { kind: "unavailable", why: log.why };
}

if (import.meta.main) {
  const [repo, number] = process.argv.slice(2);
  if (!repo?.includes("/") || !/^\d+$/.test(number ?? "")) {
    console.error("usage: bun danger.ts <owner/repo> <pr-number>");
    process.exit(2);
  }
  const pr = ghJson([`repos/${repo}/pulls/${number}`]);
  const head = isObj(pr) && isObj(pr.head) ? str(pr.head.sha) : null;
  const headRepo = isObj(pr) && isObj(pr.head) && isObj(pr.head.repo) ? str(pr.head.repo.full_name) : null;
  const baseRepo = isObj(pr) && isObj(pr.base) && isObj(pr.base.repo) ? str(pr.base.repo.full_name) : null;
  const base = isObj(pr) && isObj(pr.base) && isObj(pr.base.repo) ? str(pr.base.repo.default_branch) : null;
  const author = isObj(pr) && isObj(pr.user) ? str(pr.user.login) : null;
  if (!isObj(pr) || head === null || base === null || baseRepo === null) throw new Error(`GitHub returned no head SHA, base repo, or default branch for ${repo}#${number}`);
  const pages = ghJson(["--paginate", "--slurp", `repos/${repo}/commits/${head}/statuses?per_page=100`]);
  const statuses = (Array.isArray(pages) ? pages.flat() : []).map(parseStatus);
  const workflow = gh([`repos/${repo}/contents/${SCORER_PATH}?ref=${encodeURIComponent(base)}`, "--jq", ".path"]);
  if (!workflow.ok && !workflow.why.includes("HTTP 404")) throw new Error(`could not tell whether ${repo} runs the scorer: ${workflow.why}`);
  const ids = new Set(statuses.filter((s) => s.context === STATUS_CONTEXT && s.state === "success").map((s) => runAttemptOf(repo, s.targetUrl)).filter((id) => id !== undefined));
  const runs = new Map([...ids].map((id) => {
    const run = parseRun(ghJson([`repos/${repo}/actions/runs/${id}`]));
    const proof: RunProof = run.status === "completed" && run.conclusion === "success" ? readRunProof(repo, id) : { kind: "unavailable", why: "the run has not completed successfully" };
    return [id, { ...run, proof }] as const;
  }));
  const scorer: Scorer = { installed: scorerWillRun(workflow.ok, { headRepo, baseRepo, author }), repo, head, inputs: inputFingerprint(parseEvent({ pull_request: pr })), runs };
  const danger = dangerOf({ title: str(pr.title) ?? "", body: str(pr.body) ?? "" }, readStatus(statuses, scorer));
  console.log(`merge danger on ${head.slice(0, 7)}: ${danger.verdict}. ${danger.why}`);
  process.exit(danger.verdict === "agent" ? 0 : danger.verdict === "wait" ? 3 : 1);
}
