---
description: "Merge authorized PRs through verified review/CI gates, record delivery, and run authorized post-merge actions."
---

# /merge

Merge authorized PRs through verified review/CI gates, record delivery, and run authorized post-merge actions. The same gated merge authority applies in ordinary and prime-directive runs.

## Arguments

- `$ARGUMENTS` - PR numbers, `all`, or flags:
  - `123` or `123 456` — specific PR(s)
  - `all` — all open PRs targeting main, only when the user explicitly requests this scope
  - `--skip-version-check` — don't wait for auto-version CI

## Instructions

### Phase 0: Authority and Mandatory Review Gate

Delegated implementation includes merging its PRs once the gates pass. Honor explicit user holds, required human approvals and unavailable permissions; no extra merge confirmation is needed because the user is present. This does not authorize unrelated existing PRs or turn a review-only request into a merge request. Use the PR set recorded by the delivery workflow, or PRs explicitly selected by the user. Do not infer `all` from an empty argument.

**CRITICAL: Every PR MUST be reviewed before merging.** Run `/full-review` for this PR or verify existing evidence covering its current head. Documentation and version-only PRs follow the same gate; a small diff is not a review exemption.

A review-comment count, a prior CLEAN label or resolved threads alone is insufficient. Verify the reviewed SHA, independent reviewer, inline and general-summary dispositions, and any subsequent fix-delta review. If changes are not covered, run the missing review before proceeding. For multiple PRs, independent reviews may run in parallel within the workflow-agent cap; merge sequentially in dependency order and recheck each dependent PR after its prerequisite lands.

For delegated implementation, continue from an accepted review through the merge gate and ledger. A clean review does not waive final-head CI, thread resolution, required approvals or an explicit hold.

### Phase 1: Pre-Merge Preparation

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

If the post-merge-only flag is set, skip to Phase 3.

Parse the authorized PR set. For explicitly requested `all`:

```bash
gh pr list --base main --state open --json number,title,headRefName,mergeStateStatus
```

For each PR, pre-check:

```bash
# CI status
gh pr checks ${PR_NUM}

# Merge state
gh pr view ${PR_NUM} --json mergeable,mergeStateStatus
```

Display a concise summary table, then proceed within the authority already granted:

```markdown
## Merge Queue ({N} PRs)

| # | PR | Title | CI | Merge State |
|---|-----|-------|----|-------------|
| 1 | #123 | feat: add feature | PASS | CLEAN |
```

### Phase 2: Merge Execution

#### Small batch (1-2 PRs): Direct merge

For each PR:

1. **Check current-head gates** — read `headRefOid`, CI, review evidence and `mergeStateStatus`. ALL CI checks must be green on the final commit, `/full-review` must be clean for that head, ALL review threads must have supported resolved dispositions, and repository protection must be satisfied. Use the host's supported status/continuation mechanism for pending checks; never substitute polling prohibited by the host.
2. **Recover a failed gate** — use `/merge-gate` to identify the actual missing requirement. A push, update-branch or prerequisite merge invalidates stale head/base readings. `UNKNOWN` needs a fresh supported status check. Handle CI fixes, owned-branch conflicts and review findings within delegated authority and the shared repair allowance; preserve unrelated changes. Ask only for a verified owner-reserved prerequisite, and keep independent authorized work moving.
3. **Resolve only supported review dispositions** — run `/check-pr` step 6b with the triage record. Its paginated GraphQL `resolveReviewThread` procedure resolves eligible threads and verifies the result. Do not resolve every unresolved thread wholesale. The Python helper passes IDs as GraphQL variables; the existing rule remains: `resolveReviewThread must use Python`. Recheck inline and general findings at the current head before declaring the review clean.
4. **Capture the checked head and merge synchronously** — first verify that the repository permits a synchronous merge. If it requires a merge queue, report that policy dependency; do not silently enqueue or use `--admin` to bypass it. Set `CHECKED_HEAD` to the full SHA whose review, CI and thread gates just passed:
   ```bash
   # Merge strategy: always --squash --delete-branch
   gh pr merge ${PR_NUM} --squash --delete-branch --match-head-commit "${CHECKED_HEAD}"
   ```
   If the head moved, recheck the gates for its new SHA. Never use `gh pr merge --auto`, GitHub auto-merge or a protection override.
5. **Verify and record immediately** — query `gh pr view ${PR_NUM} --json state,mergeCommit,mergedAt`; require `MERGED`. Append the delivered outcome, PR, accepted review, checked head/CI and merge SHA to the ledger before starting another feature or writing the final report.

#### Large batch (3+ PRs): Delegate to /batch-merge

Run `/batch-merge ${PR_NUMS}` with the authorized PR set, dependency order, shared limits and the gates above. Delegation does not waive current-head review, CI or supported thread dispositions. Verify and record each successful merge, then continue to Phase 2b with that list.

### Phase 4: Report

Report verified merged PRs and exact blockers from the ledger. For ordinary development, complete the bounded feature's delivery, then invoke `/session-lifecycle` for the uniform concise status and verified seed instructing the user to start a fresh session. In prime-directive mode, checkpoint the ledger and continue the authorized mission through supported host continuation/compaction; do not stop merely because a PR merged.

```markdown
## Merge Complete

| PR | Title | Status |
|----|-------|--------|
| #123 | feat: add feature | Merged |
| #456 | fix: resolve crash | Skipped (conflict) |

**Version:** v1.2.3 → v1.2.4
```

## Error Recovery

| Error | Recovery |
|---|---|
| CI failure on PR | Run `/fix-ci`, wait, retry merge |
| Unresolved review threads | `/check-pr`: triage, resolve supported dispositions, recheck gates |
| Merge conflict | Resolve within owned scope and repair limits; recheck review and CI |
| Version bump timeout | Warn and continue to post-merge actions |
| Post-merge build failure | Diagnose and repair within scope; report only a genuine remaining dependency |
| Divergent local branches | Preserve local work; use an owned clean worktree or reconcile deliberately |

## Critical Rules

1. **NEVER merge without /full-review** — every PR must be reviewed before merging. This is a hard gate. Run Phase 0 first.
2. **For 3+ PRs, delegate to /batch-merge** — don't reinvent sequential merge logic
3. **Version verification is informational** — never block post-merge actions on it
4. **GraphQL resolveReviewThread must use Python** — pass thread IDs as GraphQL variables
5. **Never use --admin** — respect branch protections. Never use `gh pr merge --auto` or GitHub auto-merge; check the final head and merge synchronously.
6. **Idempotent** — safe to re-run; already-merged PRs detected and skipped
7. **No attribution** — Zero Attribution Policy applies to all commits
