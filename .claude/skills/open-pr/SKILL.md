---
name: open-pr
description: Open every pull request through this skill. It self-reviews the diff, proves the change, measures the merge danger, and writes the fixed PR body (Problem, Change, Proof, Review, Merge danger) that the PR gate and the pr-kit CI check require. Use before any `gh pr create`, `gh api .../pulls`, or PR body edit.
metadata:
  category: git/pr
  lanes: [claude, codex, pi]
  machines: [universal]
  requires: [bun, git, gh]
---

# open-pr

The PR body is a briefing for a reviewer who has one minute. A gate checks the body on create, edit, and merge, and the `pr-kit` CI check checks it again. A body that breaks the contract does not open.

## Steps

1. **Rebase.** Fetch the base and rebase onto it. Stop on a conflict you cannot prove correct.
2. **Self-review with the review-gate skill.** Its pre-push receipt already needs a second-model review, so that review is the only one. Do not run `/code-review` as well.
   - Run the checks: `bun ~/.agents/skills/review-gate/scripts/review-receipt.ts run`.
   - Review the diff against the merge base with the reviewer that review-gate step 3 names. Give the reviewer what Pullfrog reads in this repo: the repo's AGENTS.md (and CLAUDE.md when AGENTS.md is absent), plus any file under `.github/pullfrog/`. A local pass then predicts a Pullfrog pass.
   - Give every finding one disposition: **Fix** (fix it now, then review again), **Decline** (write why), or **Defer** (open an issue and link it).
   - A Decline that states a fact about the code must cite the `path:line` or command that proved it in its Reason cell.
   - Record it: `bun ~/.agents/skills/review-gate/scripts/review-receipt.ts review --skill <interrogate|code-review> --act-on N --closed N --notes "<one line>"`.
   - The receipt stores only the counts. Fill the Review table from that same review, one row per finding, so the rows match the receipt.
   - Where the review-gate skill is absent, as in a cloud session, give one fresh-context reviewer the same inputs and skip the receipt commands.
3. **Prove it.** Show evidence that could fail, best first:
   - A screenshot pair or a 15 to 45 second walkthrough when the change is visible. Use the repo's recorder script when it has one.
   - The test that fails on the base and passes on the branch. Quote the failure.
   - Command output in a code block.
4. **Measure the merge danger.**
   - **Door.** Two-way when a revert undoes it. One-way when it deletes data, migrates a schema, publishes, sends, or changes a contract that others consume.
   - **Blast radius.** Find what the change can break outside the diff: callers, consumers, config, jobs, other repos. Prove the one fact that makes it safe by running code, not by reading it. Name the radius in one word: `none`, `low`, `medium`, `high`.
5. **Write the body** to a file with the template below. Write in ASD-STE100:
   - Start with the problem. No preamble, no "This PR".
   - One topic per sentence, at most 25 words. Active voice, present tense.
   - Periods and commas. No em dashes.
   - Problem uses at most four sentences.
6. **Check the body.** Run `bun <this skill's dir>/check.ts body.md --title "<title>"`. Fix every violation it names.
7. **Open the PR ready for review.** Never a draft.
   - `gh pr create --title "<title>" --body-file body.md --base <base>`
   - In a cloud session, `gh pr` can fail with a 403 because the proxy blocks GraphQL. Use REST: `gh api repos/{owner}/{repo}/pulls -f title="<title>" -F body=@body.md -f head=<branch> -f base=<base>`.
   - Attach screenshots and videos with `gh pr create|edit --attach <file>`. It needs gh 2.99 or newer. Run `gh --version` first.
   - For a remote checkout, prefer an agent session on that machine, in that checkout, so the gate and `gh` share one filesystem.
   - When `gh` runs through `ssh`, pass the body inline with a heredoc. The local gate refuses remote `--body-file` paths even when the file exists there.
   - After `--attach`, move any appended image links into Proof and keep `Changes made by ...` last. Check the body again before submitting the edit.
8. **Read it back.** `gh api repos/{owner}/{repo}/pulls/<n>` and confirm base, body, and draft state. Then hand over to the `land-pr` skill.

## Install the kit

A repo without the kit gets it in its own PR, opened with this skill. Use the first source you have:

- The fleet store: `bun ~/.agents/skills/open-pr/kit.ts install <repo>`
- A repo that already has the kit: `bun .claude/skills/open-pr/kit.ts install <repo>`
- Neither: download the two skill folders from GitHub with `gh`, then run `kit.ts` from them.

  ```bash
  repo=/path/to/repo
  (set -e; kit=$(mktemp -d); trap 'rm -rf "$kit"' EXIT
   src=repos/AojdevStudio/agents-config/contents/agents-config/kits/pr
   for s in open-pr land-pr; do
     mkdir "$kit/$s"
     gh api "$src/$s?ref=main" --jq '.[] | select(.type == "file") | .name' >"$kit/$s.files"
     while read -r f; do gh api -H "Accept: application/vnd.github.raw" "$src/$s/$f?ref=main" >"$kit/$s/$f"; done <"$kit/$s.files"
   done
   bun "$kit/open-pr/kit.ts" install "$repo")
  ```

Pass `--runs-on <label>` when the repo has no workflow yet. A second run prints "PR kit already current".

## Template

The title is a conventional commit: `fix(web): new threads no longer spike CPU`. An emoji prefix is allowed when the repo uses one.

```markdown
## Problem
One to four sentences. What is wrong, for whom, and where.

## Change
The smallest visual of the change: a shape-matched diff, a call tree, a file tree, or pseudocode. One sentence above it when the visual needs a caption.

## Proof
| Check | Before | After |
|---|---|---|
| test_name | fails: <quoted error> | passes |

Screenshot pair or walkthrough link when the change is visible.

## Review
| Finding | Disposition | Reason |
|---|---|---|
| The finding in one line | Fix / Decline / Defer #N | Why, with path:line or a proof command for a Decline about code |

## Merge danger
Door: two-way. Revert this PR to undo it.
Blast radius: low. What outside the diff could break, and the fact that proves it safe.

Closes #N
Changes made by <model> via <harness>
```

Rules the check enforces:

- `## Problem` is the first line. The five sections appear in this order, and none is empty. Extra sections such as `## Deviations` may sit between them.
- Proof holds a table, a code block, or a link.
- Code blocks use backtick or tilde fences. A heading inside one is not a section.
- Review holds a table with a `Disposition` column, and each row starts its disposition with `Fix`, `Decline`, or `Defer #<issue>`. Write `No findings.` only when it is the whole section, after a real review.
- Merge danger holds a `Door:` line and a `Blast radius:` line.
- The last line is exactly `Changes made by <model> via <harness>`, for example `Changes made by Claude Opus 5.5 via Claude Code`.
