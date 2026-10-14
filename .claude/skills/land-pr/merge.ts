/**
 * The merge decision: may this PR head merge, judged from the review bot's check-runs.
 * Pure, so the gate and tests share it. The gate fetches the state over the REST API.
 *
 * Pullfrog is the active review bot. Its `pullfrog-approval` check-run concluding
 * `success` on the exact head is the pass signal. One exception: when the bot approved
 * the previous head and the head is a merge commit on top of it (a conflict fix), the
 * approval carries forward, provided the merged-in parent is on the base branch.
 *
 * agents-config is Ossie's curated settings repo, and no review bot gates it. The list
 * lives here in the kit, never in a file the target repo could edit. The exemption holds
 * only when the merge command names the repo itself, because a repo guessed from the cwd
 * or the environment can differ from the one gh merges.
 */

export const PASS_SIGNAL = "pullfrog-approval";

const BOT_EXEMPT = new Set(["aojdevstudio/agents-config", "aojdevstudios/agents-config"]);

/** True for a repo that no review bot gates. `repo` is `owner/name`, any case. */
export const botExempt = (repo: string): boolean => BOT_EXEMPT.has(repo.toLowerCase());

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface HeadState {
  /** The PR's base repo as GitHub reports it, `owner/name`. */
  repo: string;
  /** The merge command named the repo with `-R`, a PR URL, or a literal REST path. */
  pinned: boolean;
  sha: string;
  parents: string[];
  /** Latest check-runs named PASS_SIGNAL on the head. */
  runs: CheckRun[];
  /** Latest check-runs named PASS_SIGNAL on parents[0]. Fetched only for a merge commit. */
  parentRuns?: CheckRun[];
  /** For a merge commit: parents[1] is the base branch head or one of its ancestors. */
  mergesBase?: boolean;
}

export type MergeVerdict =
  | { ok: true; via: "approval" | "conflict-fix" | "exempt" }
  | { ok: false; reason: string };

const passed = (runs: CheckRun[] | undefined) =>
  runs?.some((r) => r.name === PASS_SIGNAL && r.status === "completed" && r.conclusion === "success") ?? false;

function describe(runs: CheckRun[]): string {
  const run = runs.find((r) => r.name === PASS_SIGNAL);
  if (!run) return `no ${PASS_SIGNAL} check-run exists`;
  return run.status === "completed" ? `${PASS_SIGNAL} concluded ${run.conclusion}` : `${PASS_SIGNAL} is ${run.status}`;
}

export function decideMerge(head: HeadState): MergeVerdict {
  if (botExempt(head.repo)) {
    if (head.pinned) return { ok: true, via: "exempt" };
    return { ok: false, reason: `${head.repo} skips the review bot only when the merge names it. Pass -R ${head.repo} or the PR URL.` };
  }
  if (passed(head.runs)) return { ok: true, via: "approval" };
  if (head.parents.length === 2 && head.mergesBase === true && passed(head.parentRuns)) return { ok: true, via: "conflict-fix" };
  return { ok: false, reason: `${describe(head.runs)} on head ${head.sha.slice(0, 7)}. A missing, running, or failed verdict does not pass.` };
}
