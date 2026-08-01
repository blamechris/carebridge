# /autonomous-dev-flow

Orchestrate long-running autonomous dev sessions — work through GitHub issues sequentially with TDD, create PRs, run /full-review, then merge or flag according to this repo's self-merge posture, and continue to the next issue. PRs that don't merge accumulate for asynchronous user review while work continues.

## Arguments

- `$ARGUMENTS` - Issue source and options. Examples:
  - `label:bug` / `label:from-review` / `label:enhancement` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:from-review max:5 sort:created-asc` (with options)
  - If empty, auto-detect: scan open issues and order by this repo's priority labels — `bug` → `from-review` → `enhancement`, with `p1` → `p2` → `p3` breaking ties where present
  - Options: `max:N` (default 10, hard cap 15), `sort:created-asc` (default) or `sort:created-desc`

## Instructions

### Phase 0: Queue Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# CareBridge branches carry conventional prefixes (feat/, fix/, refactor/, chore/,
# docs/, test/). This skill only ever CREATES feat/<number>-<slug>, so the prefix
# scans below key on feat/. Branches made by hand under the other prefixes are
# still caught by the PR-title "#<issue>" scan that runs alongside the prefix scan.
BRANCH_PREFIX="feat/"
```

Parse `$ARGUMENTS` to determine the issue source:

- **Explicit list**: Strip `#` prefixes, run `gh issue view ${NUM} --json number,title,state,labels,body,assignees` for each
- **Label**: `gh issue list --label "${LABEL}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Milestone**: `gh issue list --milestone "${MILESTONE}" --state open --json number,title,labels,assignees --limit ${MAX}`
- **Auto-detect** (empty args): `gh issue list --state open --json number,title,labels,assignees --limit 30` then order by priority label (`bug` → `from-review` → `enhancement`; `p1`/`p2`/`p3` break ties). This repo has no `complexity:*` labels, so oversized issues are identified by scope in Phase 0.5, not by label.

Apply sort order and cap to `max` (hard cap 15 — sessions beyond this rarely maintain quality). Recommended: 3-5 issues for first use; sessions of 10+ work best with well-specified, small-scope issues.

**Filter out assigned issues** — exclude issues with assignees from the working queue. Show them in the queue table as informational but don't process them.

**Validate the queue before starting:**
- At least 1 issue must be open and unassigned
- If all matching issues are assigned, report "All N matching issues are assigned — nothing to process" and stop
- If 0 issues match, report and stop — don't start an empty session
- Show the user the queue and get confirmation before entering the loop

```markdown
## Work Queue ({N} issues, {M} skipped as assigned)

| # | Issue | Labels | Action |
|---|-------|--------|--------|
| 1 | #12 — Retry the BullMQ clinical-events consumer on transient failure | enhancement | Implement |
| 2 | #15 — Medication reconciliation across clinical-data + ai-oversight | enhancement | Decompose → sub-issues (spans 3 workspaces) |
| — | #16 — Refactor the auth session store | enhancement | Assigned to @user (skipped) |
| 3 | #18 — Integration tests for the auth MFA flow | test | Implement |

Start autonomous dev session?
```

Wait for user confirmation. **This is the ONLY confirmation point** — everything after runs autonomously.

After confirmation, create task list tracking:
```
For each issue in work queue:
  TaskCreate: "Issue #N — <title>" with status pending
```

### Phase 0.5: Auto-Decompose Oversized Issues

When the queue contains issues that are too large to implement directly — in this repo, issues whose scope spans 3+ workspaces across `packages/`, `services/` and `apps/` — decompose them into smaller, independently implementable sub-issues BEFORE entering the core loop. There are no `complexity:*` labels here, so the trigger is scope, not a label.

For each oversized issue:

0. Check for prior decomposition — scan the issue's comments for an existing "Decomposed into #A, #B, #C" comment. If found, use those existing sub-issues instead of creating new ones.
1. Read the full issue body: `gh issue view ${ISSUE_NUM} --json body,comments -q .`
2. Understand the full scope — files involved, systems affected, testing needs
3. Break into 2-5 sub-issues, each independently implementable. Prefer the Turborepo build order as the seam: `packages/*` → `services/*` → `apps/*`, one sub-issue per layer when an issue spans two or more. Clinical-data event-emission changes always get a sub-issue separate from producer and consumer, so the contract is reviewable in isolation.
4. Create sub-issues via `gh issue create`:

```bash
SUB_URL=$(gh issue create \
  --title "type(scope): Sub-task description" \
  --label "enhancement" \
  --body "$(cat <<'EOF'
## Summary

Specific sub-task description.

Part of #${ISSUE_NUM}

## Implementation Plan

- Files to modify: `services/<service>/src/<file>.ts`
- Test strategy: Add tests for X behavior
- Approach: [specific implementation details]

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
EOF
)")

SUB_NUM=$(basename "$SUB_URL")
```

Sub-issue labels mirror the parent's primary label (`enhancement`, `bug`, or `from-review`). Parent linkage is the body line `Part of #N` only — this repo has no `parent:#N` label scheme and no parent-marker label.

5. Insert sub-issues at FRONT of queue (context is fresh from reading the parent)
6. Comment on parent issue: `gh issue comment ${ISSUE_NUM} --body "Decomposed into #A, #B, #C — each independently implementable with TDD."`
7. Parent stays open until all sub-issues merge — do NOT close it
8. After decomposition, if the total queue exceeds 15, truncate to 15 with a message: "Queue expanded to N issues after decomposition. Processing first 15."

**Skip criteria** — auto-skip these issues (log reason in progress table):
- Empty issue body or no identifiable acceptance criteria — needs requirements before implementation
- No code path (manual testing, design docs, decisions needed)
- Requires user input not present in the description
- Deployment/release tasks
- Issues labeled `blocked` or `wontfix`
- Issues requiring design decisions with multiple valid approaches not specified

If skipping, comment on the issue:

```bash
gh issue comment ${ISSUE_NUM} --body "Skipped during autonomous dev session — [reason]. Needs manual attention."
```

### Phase 1: Sync Check (before EACH issue)

```bash
git checkout main
git pull origin main
```

Check for any PRs merged by the user since last check:

```bash
gh pr list --state merged --json number,headRefName,mergedAt --limit 20 \
  | jq --arg prefix "${BRANCH_PREFIX}" '[.[] | select(.headRefName | startswith($prefix))]'
```

Note any merged PRs in the progress table. If on a stale branch, switch back to main.

Check for existing branches/PRs from a previous session for the current issue:

```bash
# Check if issue already has a PR (search by title reference). This scan is what
# catches work branched under the fix/, refactor/, chore/, docs/ or test/ prefixes.
gh pr list --json number,title,headRefName,state --limit 50 \
  | jq --arg num "${ISSUE_NUM}" '[.[] | select(.title | contains("#" + $num))]'

# Also check by branch prefix
gh pr list --json number,title,headRefName,state --limit 50 \
  | jq --arg prefix "${BRANCH_PREFIX}" '[.[] | select(.headRefName | startswith($prefix))]'
```

- Already merged → mark as done, skip
- Open PR exists → skip (user can re-queue if needed)
- Stale branch, no PR → delete branch, re-process

### Phase 2: Issue Understanding

```bash
gh issue view ${ISSUE_NUM} --json title,body,labels,comments
```

Read the full issue. Identify:
- **Files to modify** — use Glob/Grep to find relevant code
- **Test strategy** — what behavior to test, where tests go
- **Implementation approach** — minimal path to satisfy acceptance criteria

Explore the codebase to understand the relevant code before writing anything:

```bash
# Read CLAUDE.md for project conventions
cat CLAUDE.md 2>/dev/null

# Explore relevant files based on issue description
```

If the issue body is empty or has no actionable requirements, apply skip criteria from Phase 0.5.

### Phase 3: Implementation (TDD)

Create branch following project conventions:

```bash
# Generate slug from issue title: lowercase, hyphens, no special chars, max 40 chars
ISSUE_TITLE=$(gh issue view "${ISSUE_NUM}" --json title -q '.title')
SLUG=$(printf '%s' "${ISSUE_TITLE}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)

# CareBridge convention: feat/<number>-<slug>
BRANCH="${BRANCH_PREFIX}${ISSUE_NUM}-${SLUG}"
git checkout -b "${BRANCH}"
```

**CRITICAL: Always branch from main.** Never stack branches — each PR must be independently mergeable in any order.

#### RED — Write Failing Tests First

Based on the issue's acceptance criteria, write tests that describe the desired behavior. Tests MUST fail before any implementation.

```bash
# Vitest, driven through Turborepo. The workspaces that run tests are listed in
# vitest.workspace.ts. Test files live at:
#   services/<svc>/src/__tests__/*.test.ts
#   packages/<pkg>/src/__tests__/*.test.ts   (*.int.test.ts for DB-backed integration)
#   apps/<app>/src/__tests__/*.test.ts and apps/<app>/**/*.test.tsx
#
# Whole workspace (what CI runs). DB-backed suites need Postgres up and migrations
# applied first: docker-compose up -d && pnpm db:migrate
pnpm test

# Scope to the workspace you are changing while iterating
pnpm --filter @carebridge/<workspace> test
```

If tests pass immediately, the behavior already exists — investigate before proceeding. Either the issue is already resolved or the tests don't capture the right behavior.

#### GREEN — Make Tests Pass

Write the minimum implementation to make all new tests pass. Don't over-engineer — just satisfy the tests.

```bash
pnpm test
```

If tests still fail, iterate on the implementation until they pass. Do NOT move to REFACTOR until all tests are green.

#### REFACTOR — Clean Up

With green tests as a safety net:
- Remove duplication
- Improve naming
- Simplify logic
- Ensure the code follows project conventions (per CLAUDE.md) — TypeScript strict, ESM with `.js` extensions in imports, functional style over classes, Zod validation at service boundaries, ISO 8601 date strings, `crypto.randomUUID()` for IDs

```bash
# Run tests again to confirm refactoring didn't break anything
pnpm test

# Static gates — these mirror the CI jobs; run them before pushing
pnpm typecheck && pnpm lint
```

### Phase 4: Commit and PR Creation

Stage and commit with conventional format:

```bash
# Stage relevant files (never git add -A)
git add <specific-files>

# Commit with issue reference — NO attribution
git commit -m "$(cat <<'EOF'
type(scope): description

Implements the core change described in the issue.

Refs #${ISSUE_NUM}
EOF
)"

# Types:  feat, fix, refactor, docs, test, chore, style, perf
# Scopes: db, ai, notes, clinical, auth, gateway, portal, infra

git push -u origin ${BRANCH}
```

Create PR autonomously (NO user confirmation — PRs are the async checkpoints):

```bash
# Construct PR title: conventional commit format referencing the issue
# Infer type from issue labels (bug→fix, enhancement→feat, etc.)
ISSUE_LABELS=$(gh issue view "${ISSUE_NUM}" --json labels -q '[.labels[].name] | join(",")')
case "${ISSUE_LABELS}" in
  *bug*) PR_TYPE="fix" ;;
  *test*) PR_TYPE="test" ;;
  *refactor*) PR_TYPE="refactor" ;;
  *) PR_TYPE="feat" ;;
esac
PR_TITLE="${PR_TYPE}: ${ISSUE_TITLE} (#${ISSUE_NUM})"

PR_URL=$(gh pr create \
  --title "${PR_TITLE}" \
  --body "$(cat <<'EOF'
## Summary

- Change 1
- Change 2

Refs #${ISSUE_NUM}

## Test Plan

- [ ] All new tests pass
- [ ] Existing tests unbroken
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] Affected service tested locally
EOF
)")

PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
```

### Phase 5: Full Review

**Pre-Skill Checkpoint** (MANDATORY — prevents context drift in long sessions):
1. Re-read CLAUDE.md for project conventions
2. Re-read the skill files for /full-review, /agent-review, and /check-pr

Run `/full-review ${PR_NUM}`:
- Phase 1: Agent review — deep expert review against project standards (the CareBridge Inspector persona)
- Phase 2: Check-PR — process all review comments. Copilot review IS active on this repo, so expect Copilot comments alongside the agent-review findings.

Capture results: verdict, findings counts, fixes committed, issues created/closed.

**If critical findings exist:** Fix them (standard /full-review behavior handles this). Two fix attempts max — after that, flag the PR as "Needs attention" and move on.

**Do NOT merge — Critical Rule 5 withholds merge authority for this repo.** Rule 5 records whether this repo grants unattended merge authority at all; it is the only place that decides, and nothing here overrides it. Because it withholds that authority, the Unattended Merge Gate does not apply: never merge, never `gh pr merge --auto`, never enable GitHub auto-merge, never override branch protection — however clean the verdict is. Leave the PR open, flag it in the session report, and keep working. A clean review is not a reason to revisit that.

### Phase 6: Assess, Report, and Continue

Based on /full-review results, classify the PR:

| Verdict | Meaning | Action |
|---------|---------|--------|
| Clean | No critical findings, all comments addressed | Edit PR body: `Refs` → `Closes`. Then follow Critical Rule 5: this repo withholds merge authority, so leave the PR open and flag it for user review. Mark the issue done, continue |
| Needs attention | Critical findings or unresolved comments | Keep `Refs` (don't auto-close). Flag for user, continue |
| Broken | Tests failing after review fixes | Keep `Refs` (don't auto-close). Flag for user, continue |

Update task tracking:

```
TaskUpdate: "Issue #N" → completed (or flagged)
```

Output cumulative progress table:

```markdown
## Session Progress ({completed}/{total})

| # | Issue | Branch | PR | Review | Status |
|---|-------|--------|----|--------|--------|
| 1 | #12 — Retry BullMQ consumer | feat/12-retry-bullmq-consumer | #45 | Approve (0 critical) | Done — PR open |
| 2 | #15 — Medication reconciliation | — | — | — | Decomposed → #20, #21 |
| 3 | #20 — Reconciliation data model | feat/20-reconciliation-data-model | #46 | Approve (1 suggestion) | Done — PR open |
| 4 | #18 — Auth MFA integration tests | — | — | — | In progress |
| 5 | #22 — Harden clinical-flag status transitions | — | — | — | Queued |
```

**CRITICAL: Never block the session on a flagged PR.** Flag and move on. The user handles flagged PRs during check-ins.

Return to Phase 1 for next issue.

### Phase 7: Session Summary

After all issues are processed (or the queue is exhausted), output final summary:

```markdown
## Autonomous Dev Session Complete

**Issues processed:** {N}
**Queue source:** {description}

### Results

| # | Issue | PR | Review Verdict | Status |
|---|-------|----|---------------|--------|
| 1 | #12 — Retry BullMQ consumer | [#45](url) | Approve | Open — ready for review |
| 2 | #15 — Medication reconciliation | — | — | Decomposed → #20, #21, #22 |
| 3 | #20 — Reconciliation data model | [#46](url) | Approve | Open — ready for review |
| 4 | #18 — Auth MFA integration tests | [#47](url) | Request Changes | Needs attention |

### Summary
- **Open and review-clean:** N PRs (ready for the user to merge)
- **Open / needs attention:** M PRs (details below)
- **Decomposed:** K issues → L sub-issues created
- **Skipped:** J issues (reasons below)
- **Issues created during reviews:** #A, #B, #C
- **PRs merged by user during session:** #X, #Y

### Needs Attention
- **PR #47** (#18 — Auth MFA integration tests): 1 critical finding — TOTP replay window not enforced before use. See review comment.

### Skipped Issues
- **#25**: Requires deployment setup — not automatable
- **#30**: Needs user decision on provider choice

### Next Steps
- Review and merge the review-clean PRs — this session merged nothing, because this repo withholds unattended merge authority
- Address flagged PRs (each names its failed gate)
- Review created issues for follow-up work
```

## Session Boundaries

Long autonomous runs are a sequence of bounded sessions, not one endless context — context re-reads dominate their cost, and a restart that halves context pays for itself within ~6–10 requests. When this skill runs inside a marathon (`/tackle-issues`), the wave boundary is the session boundary; run standalone, apply the same discipline at wave boundaries of its own (queue checkpoints — every few issues, and always before starting a large one). How a session ends at a wave boundary is **mode-aware**:

- **Attended runs** — end the session at the wave boundary; the user/orchestrator relaunches the next segment seeded from the handoff note (`$CLAUDE_BRIEF_DIR/../handoffs/carebridge-<YYYY-MM-DD>-handoff.md`) + the queue (`$CLAUDE_BRIEF_DIR/../handoffs/carebridge-<YYYY-MM-DD>-queue.json`). Both live beside the brief vault and OUTSIDE the repo: `scratchpad/` is not in this repo's `.gitignore`, so an in-tree queue file would show up in `git status` and risk being committed.
- **Unattended with a configured re-launcher** — none exists for this repo. There is no cron entry, no LaunchAgent and no `/loop` wrapper that restarts a CareBridge wave, so this branch never applies here; unattended runs take the branch below.
- **Unattended with no re-launcher** — the live case for this repo. Do **NOT** end the session (nothing would relaunch it): write the handoff seed, force/await a compaction at the boundary so the next segment starts lean, and continue. The cost goal — shed context at the boundary — holds in every mode.

- **~150K main-thread context ceiling.** Past ~150K tokens of main-thread context, finish the current issue only, write the short handoff note (queue position, open blockers, awaiting-user items, last verified merge), and end the session (unattended with no re-launcher: force a compaction instead). Resume Strategy below makes the fresh session lossless — it re-derives progress from GitHub state, so the handoff plus the queue is all the seed a restart needs.
- **Cost circuit breaker at wave boundaries (queue checkpoints).** At each boundary, read cumulative session cost from the statusline, which surfaces the session's `cost.total_cost_usd`. No per-session budget is configured for this repo, so the breaker has no default threshold — it fires only against a budget the user names when starting the run, and absent one there is no automatic stop; say so in the handoff rather than assuming a limit. Over the named budget → write the handoff and **stop and notify** instead of continuing. This breaker is the sole sanctioned exception to Critical Rule 4's "everything after is fully autonomous".
- **Verify state directly.** A background monitor ending is not a verdict — assert PR/CI state with a direct query before recording it, and re-check `mergeStateStatus` at the current head after any push.

## Resume Strategy

This skill resumes from **GitHub state** — GitHub remains the source of truth for issue/PR status. The wave handoff note (Session Boundaries) carries only session-boundary seeds — queue position, open blockers, awaiting-user items, last verified merge — and is disposable: everything in it is re-derivable from GitHub. It is a seed for the next segment, not a second source of truth.

If a session is interrupted (crash, timeout, user stops it), re-running with the same arguments will:

1. Query GitHub for existing session branches (matching `BRANCH_PREFIX`) and PRs referencing each issue
2. Skip issues that already have merged or open PRs
3. Resume from the first issue without a PR

This makes the skill **idempotent** — safe to re-run without duplicating work. The same idempotence is what makes deliberate session-boundary restarts (above) lossless.

## Critical Rules

1. **NO attribution** — No Co-Authored-By, no "Generated with Claude", no AI mentions anywhere. Zero Attribution Policy (see CLAUDE.md).
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every issue. No skipping tests. If pure docs/config, note why tests are N/A.
3. **Branch from main every time** — Never stack branches. Each PR is independently mergeable in any order.
4. **One confirmation point** — The initial queue approval. Everything after is fully autonomous; the sole sanctioned stop is the cost circuit breaker (see Session Boundaries).
5. **Self-merge authority for this repo** — NEVER merge, however clean the PR is. This repo does not grant unattended merge authority and the Unattended Merge Gate does not apply here. PRs accumulate for user review — flag each finished PR in the session report and keep working. A clean gate is not permission, because there is no gate to pass.
6. **Never block on review findings** — Flag and move on. The user handles flagged PRs during check-ins.
7. **Two fix attempts max** — If /full-review finds critical issues, fix them. If a second attempt still fails, flag and move on.
8. **Progress table after every issue** — The user may check in at any time. The table must be current.
9. **Respect the hard cap** — Max 15 issues per session segment (wave). Refuse larger queues.
10. **Resume from GitHub state** — GitHub is the source of truth for issue/PR status; query branches matching `BRANCH_PREFIX` and PR titles to detect prior work. The wave handoff note is a disposable session-boundary seed, never a second source of truth.
11. **Compose existing skills** — /full-review is called as-is (chains /agent-review → /check-pr). Don't reinvent their logic.
12. **Decompose, don't skip** — Oversized issues get broken into sub-issues, not skipped. Only skip truly non-automatable work.
13. **Comment on skips** — Every skipped issue gets a GitHub comment explaining why. The user sees the reason.
14. **Pre-Skill Checkpoint** — Re-read CLAUDE.md and skill files before running /full-review to prevent context drift.
15. **Sync before branching** — Always `git checkout main && git pull` before starting each issue. Check for merged PRs first.

<!-- skill-templates: autonomous-dev-flow 8196307 2026-08-01 -->
