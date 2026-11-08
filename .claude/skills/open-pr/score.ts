#!/usr/bin/env bun
/**
 * Scores a pull request's merge danger with Jev (TypeSafe AI) and posts it as the
 * `merge-danger` commit status on the exact head. The merge-danger workflow runs it from the
 * default branch on every same-repo PR, so every PR is scored the same way, whoever wrote it,
 * and never by its own author. land-pr reads the status (land-pr/danger.ts).
 *
 *   bun score.ts --event "$GITHUB_EVENT_PATH"
 *
 * Env: GITHUB_TOKEN (statuses: write), GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL,
 * GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT. Jev's key comes from TYPESAFE_API_KEY when set, else KEY_FILE on the
 * runner. The workflow passes no repo secret.
 *
 * It reads the PR only through the event payload and the API, never by checking it out. It asks
 * Jev four questions in one call (door, reach, likelihood, control) and combines the answers in
 * code (combine). A diff too large for one call is rated in parts (statesFor), and the highest
 * radius stands. When it cannot rate the PR (no key, Jev or GitHub failed, or the diff is empty
 * or cannot be split without losing a line) it posts `error` with the reason, never a rating.
 * The run then exits 1.
 * The status's run link identifies the comparison and metadata with a SHA-256 fingerprint.
 * The job log records that fingerprint and the actual radius. land-pr verifies both through
 * GitHub's attempt-scoped log API instead of trusting the caller-supplied status text.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { withoutSection } from "./contract";

export const STATUS_CONTEXT = "merge-danger";
export const RADII = ["none", "low", "medium", "high"] as const;
export type Radius = (typeof RADII)[number];

/** The four axes Jev answers, each as its own question. Their option keys are the values code combines. */
export const DOORS = ["two_way", "one_way", "unclear"] as const;
export const REACHES = ["none", "local", "repo", "external"] as const;
export const LIKELIHOODS = ["low", "elevated", "high"] as const;
export const CONTROLS = ["weakens", "neutral", "no"] as const;
export interface Axes {
  door: (typeof DOORS)[number];
  reach: (typeof REACHES)[number];
  likelihood: (typeof LIKELIHOODS)[number];
  control: (typeof CONTROLS)[number];
}

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Each GitHub or Jev request gets this long, so a hung request ends in an error status. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Jev reads at most 32k tokens per question: the state plus that one question
 * (docs.typesafe.ai/models). Bound the complete request by UTF-8 bytes instead of assuming four
 * characters per token. This includes every question and leaves room for provider framing.
 */
const REQUEST_BYTE_BUDGET = 30_000;
/** Bound model work and keep scoring inside the workflow's five-minute job limit. */
const MAX_PARTS = 24;
const SCORING_REQUEST_WINDOWS = 6;
/** GitHub caps a commit status description at 140 characters. */
const DESCRIPTION_MAX = 140;
/** Where the homelab-ci runner keeps Jev's key, written from BWS (ROLLOUT.md). */
export const KEY_FILE = "/etc/merge-danger/typesafe_api_key";

/**
 * Evidence first. Every option describes something the changed lines do, never a kind of file or
 * path. An option above the lowest needs a changed line that shows it. The questions never say
 * what a level does to the merge: code combines the axes (combine), so the policy cannot move the
 * judgment. Jev reads `title`, `body` (the author's own Merge danger section removed), and `diff`.
 */
const EVIDENCE = "Judge by what the changed lines in `diff` do, not by which files or paths they are in. Pick an answer above the lowest only when a changed line shows it. When no changed line shows it, pick the lower answer.";

export const QUESTIONS = {
  door: {
    type: "choice",
    instructions: `After a plain revert of the pull request in \`diff\` (described by \`title\` and \`body\`), does anything it did stay changed? ${EVIDENCE}`,
    criteria: {
      two_way: "No. Every effect of the changed lines ends when they are reverted: code, tests, docs, config, or CI that a revert puts back, or removing entries that nothing reads",
      one_way: "Yes. A changed line does something a revert cannot undo: it deletes or rewrites stored data, migrates a schema, publishes a package or release, sends a message, deploys to users when merged, spends money, puts a secret where others can read it, or changes an interface that another repo or person already uses",
      unclear: "A changed line starts a deploy, publish, migration, or job, and `diff` does not show whether that happens when the pull request merges",
    },
  },
  reach: {
    type: "score",
    instructions: `If the changed lines in \`diff\` are wrong, what is the widest thing that reads or runs them? Count only what a changed line shows reads or runs it: a call, an import, a config key, a job step, or an instruction that an agent follows. ${EVIDENCE}`,
    criteria: [
      "Nothing reads or runs the changed lines: comments, prose for human readers, or tests that only add cases",
      "Only the changed code and its direct callers in this repo, in code that does not ship to users: tests, scripts, examples, or internal tooling",
      "Code, config, CI steps, scheduled jobs, or agent instructions (AGENTS.md, CLAUDE.md, skills, prompts) that other parts of this repo read or run",
      "Something outside this repo reads or runs the changed lines: other repos, deployed services, other machines, credentials, stored data, or users, including runtime code that the project ships in a release, package, app, or service",
    ],
  },
  likelihood: {
    type: "score",
    instructions: `How likely is it that the changed lines in \`diff\` do not do what \`title\` and \`body\` say? Size alone is not evidence, and lockfiles and generated files do not count. ${EVIDENCE}`,
    criteria: [
      "The changed lines keep behavior the same (a rename, move, format, dead code removal, docs, a test that only adds cases, or a patch version bump), or add small new logic in one place with a test in `diff` that covers it",
      "The changed lines add or change logic across several files or areas, change what the code does at run time (not only its shape) with no test in `diff` that checks the new behavior, fix tricky logic, bump a minor or major dependency version, or include parts that cannot be read (generated, binary, or cut off)",
      "A changed line shows a concrete defect: a wrong condition, a removed check, a type escape, a weakened or deleted test, or code that does not do what `title` or `body` says",
    ],
  },
  control: {
    type: "choice",
    instructions: `Do the changed lines in \`diff\` change how a control works? Controls are auth, permissions, secrets handling, a merge or review gate, CI trust settings (\`pull_request_target\`, tokens, \`permissions:\` blocks), a deploy or release pipeline, branch protection, and safety hooks. ${EVIDENCE}`,
    criteria: {
      weakens: "Yes, and a changed line lets through something that was blocked before, widens a permission, adds an entry to an allowlist, approved list, or exemption list, skips or bypasses a check, or exposes a secret",
      neutral: "Yes, and the control keeps the same behavior or gets stricter: a refactor, a move, or an added check",
      no: "No changed line alters how any control works",
    },
  },
} as const;

/** Reach by likelihood, from the research's matrix (eval/RESEARCH.md, Combining). */
export const MATRIX: Record<Axes["reach"], Record<Axes["likelihood"], Radius>> = {
  none: { low: "none", elevated: "none", high: "low" },
  local: { low: "low", elevated: "low", high: "medium" },
  repo: { low: "low", elevated: "medium", high: "high" },
  external: { low: "medium", elevated: "high", high: "high" },
};

/** The blast radius, combined in code exactly as eval/RESEARCH.md's Combining section says. */
export function combine(axes: Axes): Radius {
  if (axes.door === "one_way" || axes.control === "weakens") return "high";
  let level = RADII.indexOf(MATRIX[axes.reach][axes.likelihood]);
  if (axes.control === "neutral") level = Math.max(level, Math.min(level + 1, RADII.indexOf("medium")));
  if (axes.door === "unclear") level = Math.min(level + 1, RADII.length - 1);
  return RADII[level];
}

export interface PullEvent {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
}

const SHA = /^[0-9a-f]{40}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const shaOf = (x: unknown, what: string): string => {
  const sha = isObj(x) ? x.sha : undefined;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error(`the event's ${what}.sha is not a commit SHA`);
  return sha;
};

export function parseEvent(event: unknown): PullEvent {
  const pr = isObj(event) ? event.pull_request : undefined;
  if (!isObj(pr) || typeof pr.number !== "number") throw new Error("the event holds no pull_request payload");
  return {
    number: pr.number,
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    headSha: shaOf(pr.head, "head"),
    baseSha: shaOf(pr.base, "base"),
  };
}

/** Each axis's answer with the probability Jev gave it. */
export type Rating = { [K in keyof Axes]: { value: Axes[K]; p: number } };

export type Outcome = { state: "success"; radius: Radius; axes: Rating } | { state: "error"; why: string };

const shown = (value: string) => value.replace("_", "-");
/** The `success` description. danger.ts reads the radius back from its first words. */
export const describeRating = (r: Extract<Outcome, { state: "success" }>) =>
  `Blast radius ${r.radius}. ${(Object.keys(r.axes) as (keyof Axes)[]).map((k) => `${k} ${shown(r.axes[k].value)} ${r.axes[k].p.toFixed(2)}`).join(", ")}.`;
export const RATING = /^Blast radius (none|low|medium|high)\b/;
/** Credential shapes, replaced before anything leaves the runner (from the jev-ask skill's client). */
const SECRET_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS))=("[^"]*"|'[^']*'|\S+)/g, "$1=[REDACTED]"],
  [/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
];
const redact = (text: string) => SECRET_SHAPES.reduce((t, [re, to]) => t.replace(re, to), text);
/** Refuse possible private keys before redaction can hide source between unrelated markers. */
const PRIVATE_KEY_MARKER = /-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----/;

const PNG_URI = /data:image\/png;base64,([A-Za-z0-9+/]+={0,2})/g;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Whether the bytes have complete PNG framing: the signature, IHDR first, chunks that fit, and IEND last. */
function wholePng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const type = bytes.toString("latin1", at + 4, at + 8);
    const end = at + 12 + bytes.readUInt32BE(at);
    if (end > bytes.length || (at === 8 && type !== "IHDR")) return false;
    if (type === "IEND") return end === bytes.length;
    at = end;
  }
  return false;
}

/**
 * Each PNG data URI's pixels as their size and SHA-256, so screenshots embedded in SVG do not
 * fill Jev's budget. Only canonical base64 that decodes to complete PNG framing is replaced. Anything else
 * stays as written. This runs before redact, which could otherwise rewrite part of a payload.
 */
const opaqueRasters = (diff: string) =>
  diff.replace(PNG_URI, (uri, data: string) => {
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || !wholePng(bytes)) return uri;
    return `data:image/png;base64,[opaque PNG: ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}]`;
  });

/** What Jev reads: the title, the body without the author's Merge danger section, and the diff, each with credentials redacted. */
export const jevState = (pr: { title: string; body: string }, diff: string) => ({
  title: redact(pr.title),
  body: redact(withoutSection(pr.body, "Merge danger")),
  diff: redact(opaqueRasters(diff)),
});
type JevState = ReturnType<typeof jevState>;
const requestFor = (state: JevState) => ({ model: "jev-latest", state, questions: QUESTIONS });
const requestBytes = (state: JevState) => Buffer.byteLength(JSON.stringify(requestFor(state)), "utf8");

function statesFor(pr: { title: string; body: string }, diff: string): JevState[] | string {
  const whole = jevState(pr, diff);
  if (requestBytes(whole) <= REQUEST_BYTE_BUDGET) return [whole];
  const lines = whole.diff.split("\n");
  const inventory = lines.filter((line) => line.startsWith("diff --git ")).map((line) => line.replace(/^diff --git a\/(.+) b\/\1$/, "$1")).join("\n");
  const label = `[Scorer note: this is one part of a complete diff, not a patch to apply. No text lines are discarded. File and hunk headers repeat at boundaries. Other parts contain the remaining source. The highest radius across all parts counts. Full file inventory follows.]\n${inventory}\n[Part source follows.]\n`;
  const part = (source: string[]): JevState => ({ ...whole, diff: label + source.join("\n") });
  const tooLarge = `cannot split the diff within the ${REQUEST_BYTE_BUDGET}-byte request bound`;
  if (requestBytes(part([])) > REQUEST_BYTE_BUDGET) return `${tooLarge}: its title, body, questions, and file inventory do not fit. The owner decides.`;
  const parts: JevState[] = [];
  let source: string[] = [];
  let fileHeaders: string[] = [];
  let hunkHeader: string | undefined;
  for (const line of lines) {
    const startsFile = line.startsWith("diff --git ");
    const startsHunk = line.startsWith("@@");
    if (requestBytes(part([...source, line])) > REQUEST_BYTE_BUDGET) {
      if (!source.length) return `${tooLarge}: a source line does not fit. The owner decides.`;
      parts.push(part(source));
      if (parts.length >= MAX_PARTS) return `${tooLarge}: it needs more than ${MAX_PARTS} parts. The owner decides.`;
      source = startsFile ? [] : [...fileHeaders, ...(startsHunk || hunkHeader === undefined ? [] : [hunkHeader])];
      if (requestBytes(part([...source, line])) > REQUEST_BYTE_BUDGET) return `${tooLarge}: a source line and its file context do not fit. The owner decides.`;
    }
    source.push(line);
    if (startsFile) {
      fileHeaders = [line];
      hunkHeader = undefined;
    } else if (startsHunk) hunkHeader = line;
    else if (hunkHeader === undefined) fileHeaders.push(line);
  }
  if (source.length) parts.push(part(source));
  return parts;
}

/** Immutable comparison commits and the metadata Jev reads, bound to this PR. */
export const inputFingerprint = (pr: PullEvent): string =>
  createHash("sha256").update(JSON.stringify([pr.number, pr.headSha, pr.baseSha, jevState(pr, "")])).digest("hex");

export interface ScoreEvidence {
  inputs: string;
  radius: Radius;
}
export const PROOF_PREFIX = "merge-danger-proof: ";

/** One structured record in the trusted scorer job's log, read back through GitHub. */
export const evidenceLine = (pr: PullEvent, radius: Radius): string =>
  `${PROOF_PREFIX}${JSON.stringify({ inputs: inputFingerprint(pr), radius } satisfies ScoreEvidence)}`;

const probability = (x: unknown): x is number => typeof x === "number" && x >= 0 && x <= 1;

type Answer<T extends string> = { value: T; p: number } | string;

/** The probabilities for every option, which must all be present and sum to 1. */
function distribution(byOption: Record<string, unknown>, keys: readonly string[]): number[] | string {
  const ps = keys.map((k) => byOption[k]);
  if (!ps.every(probability)) return "unexpected shape";
  const total = ps.reduce((sum, p) => sum + p, 0);
  return Math.abs(total - 1) > 0.05 ? `probabilities that do not sum to 1 (they sum to ${total.toFixed(2)})` : ps;
}

/** A Choice answer: Jev's pick, with its probability. */
function choiceOf<T extends string>(answer: unknown, options: readonly T[]): Answer<T> {
  if (!isObj(answer) || answer.type !== "choice" || !isObj(answer.probabilities)) return "unexpected shape";
  const value = options.find((o) => o === answer.choice);
  if (value === undefined) return `not one of ${options.join(", ")}`;
  const ps = distribution(answer.probabilities, options);
  return typeof ps === "string" ? ps : { value, p: ps[options.indexOf(value)] };
}

/** A Score answer: the most likely level. A tie takes the lower level, since a level above the lowest needs evidence. */
function levelOf<T extends string>(answer: unknown, levels: readonly T[]): Answer<T> {
  if (!isObj(answer) || answer.type !== "score" || !isObj(answer.probabilities)) return "unexpected shape";
  const ps = distribution(answer.probabilities, levels.map((_, i) => String(i)));
  if (typeof ps === "string") return ps;
  const top = ps.reduce((best, p, i) => (p > ps[best] ? i : best), 0);
  return { value: levels[top], p: ps[top] };
}

/** Jev's four answers as a rating, combined in code. */
export function rate(response: unknown): Outcome {
  const answers = isObj(response) && isObj(response.answers) ? response.answers : {};
  const fail = (axis: string, why: string): Outcome => ({ state: "error", why: `Jev answered ${axis} with ${why}.` });
  const door = choiceOf(answers.door, DOORS);
  if (typeof door === "string") return fail("door", door);
  const reach = levelOf(answers.reach, REACHES);
  if (typeof reach === "string") return fail("reach", reach);
  const likelihood = levelOf(answers.likelihood, LIKELIHOODS);
  if (typeof likelihood === "string") return fail("likelihood", likelihood);
  const control = choiceOf(answers.control, CONTROLS);
  if (typeof control === "string") return fail("control", control);
  const axes = { door, reach, likelihood, control };
  const radius = combine({ door: door.value, reach: reach.value, likelihood: likelihood.value, control: control.value });
  return { state: "success", radius, axes };
}

export interface ScoreRun {
  event: PullEvent;
  /** `owner/name`. */
  repo: string;
  token: string;
  /** TYPESAFE_API_KEY from the environment, when set. It wins over keyFile. */
  key: string | undefined;
  /** The key file on the runner, read when `key` is unset. KEY_FILE outside tests. */
  keyFile: string;
  api: string;
  /** The workflow run URL, before the attempt path and input fingerprint. */
  runUrl: string;
  /** The producing attempt, from GITHUB_RUN_ATTEMPT. */
  runAttempt: string;
  fetch: typeof fetch;
  /** Per request. REQUEST_TIMEOUT_MS when absent. */
  timeoutMs?: number;
}

const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 80);

/** The key file's contents, or undefined when the file does not exist. Any other read error throws. */
function readKeyFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (err) {
    if (isObj(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

async function judge(run: ScoreRun): Promise<Outcome> {
  const key = run.key || readKeyFile(run.keyFile);
  if (!key) return { state: "error", why: "no Jev key on this runner" };
  const { event } = run;
  const diffRes = await run.fetch(`${run.api}/repos/${run.repo}/compare/${event.baseSha}...${event.headSha}`, {
    headers: { Accept: "application/vnd.github.diff", Authorization: `Bearer ${run.token}`, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(run.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const diff = await diffRes.text();
  if (!diffRes.ok) return { state: "error", why: `GitHub answered ${diffRes.status} for the diff: ${firstLine(diff)}` };
  if (diff.trim() === "") return { state: "error", why: "the diff is empty, so there is nothing to rate." };
  if ([event.title, event.body, diff].some((text) => PRIVATE_KEY_MARKER.test(text))) {
    return { state: "error", why: "the inputs contain private-key markers. Remove the key or markers before scoring." };
  }
  const states = statesFor(event, diff);
  if (typeof states === "string") return { state: "error", why: states };
  const requestTimeout = run.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const expiresAt = performance.now() + SCORING_REQUEST_WINDOWS * requestTimeout;
  let highest: Extract<Outcome, { state: "success" }> | undefined;
  for (const state of states) {
    const remaining = expiresAt - performance.now();
    if (remaining <= 0) return { state: "error", why: "the combined scoring time budget expired. The owner decides." };
    const outcome = await ask({ ...run, timeoutMs: Math.min(requestTimeout, remaining) }, key, state);
    if (outcome.state === "error") return outcome;
    if (highest === undefined || RADII.indexOf(outcome.radius) > RADII.indexOf(highest.radius)) highest = outcome;
  }
  return highest ?? { state: "error", why: "the diff gave no part to rate." };
}

/** One Jev call on one state, as a rating. */
async function ask(run: ScoreRun, key: string, state: JevState): Promise<Outcome> {
  const jevRes = await run.fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(requestFor(state)),
    signal: AbortSignal.timeout(run.timeoutMs ?? REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  const text = await jevRes.text();
  if (!jevRes.ok) return { state: "error", why: `Jev answered ${jevRes.status}: ${firstLine(text.split(key).join("[REDACTED]"))}` };
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return { state: "error", why: "Jev answered in an unexpected shape (not JSON)." };
  }
  return rate(answer);
}

/** Scores the PR and posts the status. Throws only when GitHub refuses the status itself. */
export async function score(run: ScoreRun): Promise<Outcome> {
  const outcome = await judge(run).catch((err: unknown): Outcome => ({ state: "error", why: `the scorer failed: ${err instanceof Error ? err.message : String(err)}` }));
  const description = outcome.state === "success" ? describeRating(outcome) : `Not rated: ${outcome.why}`;
  const res = await run.fetch(`${run.api}/repos/${run.repo}/statuses/${run.event.headSha}`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${run.token}`, "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ state: outcome.state, context: STATUS_CONTEXT, description: description.slice(0, DESCRIPTION_MAX), target_url: `${run.runUrl}/attempts/${run.runAttempt}#inputs=${inputFingerprint(run.event)}` }),
    signal: AbortSignal.timeout(run.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub refused the ${STATUS_CONTEXT} status with ${res.status}: ${firstLine(await res.text())}`);
  return outcome;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { event: { type: "string" } } });
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set. Run score.ts from the merge-danger workflow.`);
    return value;
  };
  if (!values.event) throw new Error("usage: bun score.ts --event <path>");
  const repo = env("GITHUB_REPOSITORY");
  const event = parseEvent(JSON.parse(readFileSync(values.event, "utf8")));
  const outcome = await score({
    event,
    repo,
    token: env("GITHUB_TOKEN"),
    key: process.env.TYPESAFE_API_KEY || undefined,
    keyFile: KEY_FILE,
    api: process.env.GITHUB_API_URL ?? "https://api.github.com",
    runUrl: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`,
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    fetch,
  });
  if (outcome.state === "success") {
    console.log(evidenceLine(event, outcome.radius));
    console.log(`${STATUS_CONTEXT}: ${describeRating(outcome)}`);
  }
  else {
    console.error(`${STATUS_CONTEXT}: ${outcome.state}. ${outcome.why}`);
    process.exit(1);
  }
}
