# /autonomous-dev-flow

Orchestrate long-running autonomous dev sessions — work through GitHub issues sequentially with TDD, create PRs, run /full-review, and continue to the next issue. The user reviews and merges PRs asynchronously while work continues.

## Arguments

- `$ARGUMENTS` - Issue source and options. Examples:
  - `label:ready-to-build` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:ready-to-build max:5 sort:created-asc` (with options)
  - If empty, auto-detect: scan open issues sorted by complexity (low first, then medium, skip high)
  - Options: `max:N` (default 10, hard cap 15), `sort:created-asc` (default) or `sort:created-desc`

## Instructions

### Phase 0: Queue Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Branch prefix for autonomous session branches
BRANCH_PREFIX="feat/"
```

Parse `$ARGUMENTS` to determine the issue source. Filter out assigned issues. Validate at least 1 open unassigned issue exists.

Show user the queue and get confirmation. **This is the ONLY confirmation point.**

### Phase 0.5: Auto-Decompose High-Complexity Issues

When the queue contains issues touching 3+ packages/services, decompose them into smaller, independently implementable sub-issues BEFORE entering the core loop.

For each high-complexity issue:
1. Check for prior decomposition comments
2. Read the full issue body
3. Break into 2-5 sub-issues, each low or medium complexity
4. Create sub-issues via `gh issue create`
5. Insert sub-issues at FRONT of queue
6. Comment on parent issue with decomposition links
7. Parent stays open until all sub-issues merge

**Skip criteria:** Empty body, no acceptance criteria, no code path, requires user input, deployment tasks, labeled `blocked` or `wontfix`.

### Phase 1: Sync Check (before EACH issue)

```bash
git checkout main
git pull origin main
```

Check for merged PRs and existing branches/PRs for the current issue.

### Phase 2: Issue Understanding

Read the full issue. Identify files to modify, test strategy, implementation approach. Read CLAUDE.md for conventions.

### Phase 3: Implementation (TDD)

```bash
SLUG=$(printf '%s' "${ISSUE_TITLE}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
BRANCH="feat/${ISSUE_NUM}-${SLUG}"
git checkout -b "${BRANCH}"
```

#### RED — Write Failing Tests First

Based on acceptance criteria, write tests that fail. Run `pnpm typecheck && pnpm lint` to confirm.

#### GREEN — Make Tests Pass

Write minimum implementation. Run tests to confirm.

#### REFACTOR — Clean Up

With green tests: remove duplication, improve naming, simplify logic, follow CLAUDE.md conventions.

```bash
pnpm typecheck && pnpm lint
```

### Phase 4: Commit and PR Creation

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
type(scope): description

Implements the core change described in the issue.

Refs #${ISSUE_NUM}
EOF
)"
```

Commit scopes: `db`, `ai`, `notes`, `clinical`, `auth`, `gateway`, `portal`, `infra`

```bash
git push -u origin ${BRANCH}

PR_URL=$(gh pr create \
  --title "${PR_TYPE}: ${ISSUE_TITLE} (#${ISSUE_NUM})" \
  --body "$(cat <<'EOF'
## Summary

- Change 1
- Change 2

Refs #${ISSUE_NUM}

## Test Plan

- [ ] pnpm typecheck passes
- [ ] pnpm lint passes
- [ ] Affected service tested locally
EOF
)")
```

### Phase 4.5: Smoke Test (if applicable)

```bash
CHANGED_FILES=$(git diff --name-only main...HEAD)
if echo "$CHANGED_FILES" | grep -qE 'apps/.*\.(tsx|css)$|components'; then
  NEEDS_SMOKE_TEST=true
fi
```

If UI files changed, run smoke test. Max 2 fix attempts.

### Phase 5: Full Review

**Pre-Skill Checkpoint** (MANDATORY):
1. Re-read CLAUDE.md
2. Re-read skill files for /full-review, /agent-review, /check-pr

Run `/full-review ${PR_NUM}`. Two fix attempts max. **Do NOT merge.**

### Phase 6: Assess, Report, and Continue

Classify PR verdict (Clean / Needs attention / Broken). Update task tracking. Output cumulative progress table. Return to Phase 1 for next issue.

### Phase 7: Session Summary

Final summary with all issues processed, PRs created, verdicts, and next steps.

## Resume Strategy

Uses **GitHub state** for resume — no local state files. Idempotent and safe to re-run.

## Critical Rules

1. **NO attribution** — Zero Attribution Policy.
2. **TDD is mandatory** — RED → GREEN → REFACTOR for every issue.
3. **Branch from main every time** — Never stack branches.
4. **One confirmation point** — The initial queue approval.
5. **Never merge** — PRs accumulate for user review.
6. **Never block on review findings** — Flag and move on.
7. **Two fix attempts max**
8. **Progress table after every issue**
9. **Respect the hard cap** — Max 15 issues per session.
10. **Resume from GitHub state**
11. **Compose existing skills** — /full-review called as-is.
12. **Decompose, don't skip** — High-complexity issues get broken into sub-issues.
13. **Comment on skips**
14. **Pre-Skill Checkpoint** before /full-review.
15. **Sync before branching**
<!-- skill-templates: autonomous-dev-flow manual-deploy 2026-04-10 -->
