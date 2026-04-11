# /merge

Merge PRs with mandatory review gate.

## Arguments

- `$ARGUMENTS` - PR numbers, `all`, or flags:
  - `123` or `123 456` — specific PR(s)
  - `all` — all open PRs targeting main
  - `--skip-version-check` — don't wait for auto-version CI

## Instructions

### Phase 0: Mandatory Review Gate

**CRITICAL: Every PR MUST be reviewed before merging. No exceptions for "obvious" fixes.**

For each PR to be merged, check if `/full-review` has already been run:

```bash
gh api repos/${REPO}/issues/${PR_NUM}/comments --jq '[.[] | select(.body | test("Code Review|Review Comments Addressed"))] | length'
```

If no review exists, run `/full-review ${PR_NUM}` **before proceeding to merge**.

**Exception:** Pure `.md` skill/doc files with zero code changes may skip review.

### Phase 1: Pre-Merge Preparation

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

Parse PR numbers. Pre-check CI and merge state for each.

### Phase 2: Merge Execution

#### Small batch (1-2 PRs): Direct merge

For each PR:
1. Check CI — poll pending, `/fix-ci` if failed
2. Check merge state — handle blockers
3. Resolve review threads if blocking (use Python for GraphQL)
4. Squash merge:

```bash
gh pr merge ${PR_NUM} --squash --delete-branch
```

5. Verify merged state

#### Large batch (3+ PRs): Delegate to /batch-merge

### Phase 2b: Version Verification

No auto-version configured. Skip this phase.

### Phase 3: Post-Merge Actions

No post-merge build/deploy steps configured. Pull latest main:

```bash
git checkout main
git pull --ff-only origin main
```

### Phase 4: Report

```markdown
## Merge Complete

| PR | Title | Status |
|----|-------|--------|
| #123 | feat: add feature | Merged |
```

## Critical Rules

1. **NEVER merge without /full-review** — every PR must be reviewed. Hard gate.
2. **For 3+ PRs, delegate to /batch-merge**
3. **GraphQL resolveReviewThread must use Python** — bash corrupts Base64 thread IDs
4. **Never use --admin**
5. **Idempotent** — safe to re-run
6. **No attribution** — Zero Attribution Policy
7. **/full-review is MANDATORY before every merge — no exceptions** (per CLAUDE.md merge gate)
<!-- skill-templates: merge manual-deploy 2026-04-10 -->
