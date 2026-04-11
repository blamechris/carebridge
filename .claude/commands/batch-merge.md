# /batch-merge

Sequentially merge a set of reviewed PRs, handling branch protection's "must be up-to-date" requirement by updating each branch after the previous merge.

## Arguments

- `$ARGUMENTS` - Space-separated PR numbers, `all` to merge all open PRs targeting main (sorted by number), or `--dry-run` to preview without merging.

## Instructions

### Phase 0: Build Merge Queue

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

Parse arguments. Validate each PR: must be OPEN, targeting main, not draft. Display queue for confirmation (**only confirmation point**).

### Phase 1: Pre-Flight Check

For each PR, check CI status. No Copilot review configured — skip Copilot checks.

### Phase 2: Sequential Merge Loop

For each PR:

#### Step 2a: Check CI
All required checks must pass. Poll pending checks up to 3 min. Run `/fix-ci` if failed.

#### Step 2b: Merge

```bash
gh pr merge ${PR_NUM} --squash --delete-branch
```

#### Step 2c: Update Next PR Branch

```bash
NEXT_PR=${PR_NUMS[$((current_index + 1))]}
if [ -n "$NEXT_PR" ]; then
  gh api repos/${REPO}/pulls/${NEXT_PR}/update-branch \
    --method PUT \
    -f expected_head_sha="$(gh pr view ${NEXT_PR} --json headRefOid -q .headRefOid)"
fi
```

#### Step 2d: Wait for CI on Updated Branch

Poll up to 3 minutes for CI to complete on the updated branch.

#### Step 2e: Update Progress Table

Output progress table after **every merge**.

### Phase 3: Merge Blocker Decision Tree

| Error Pattern | Action | Max Retries |
|---------------|--------|-------------|
| "not up to date" | `update-branch` → wait CI → retry | 1 |
| "status check" | `/fix-ci` → retry | 1 |
| "conflict" | Skip immediately | 0 |
| "already merged" | Skip silently | 0 |
| Rate limit | Back off 60s → retry | 2 |
| Unknown | Log error, skip | 0 |

### Phase 4: Session Summary

```markdown
## Batch Merge Complete

**Merged:** {N}/{total} | **Skipped:** {M} | **Blocked:** {K}
```

## Critical Rules

1. **Sequential only** — One at a time for branch protection.
2. **Never run reviews** — Reviews happen BEFORE this skill.
3. **Never use `--admin`**
4. **Progress table after every merge**
5. **Skip and continue** — Never block the batch on one stuck PR.
6. **Idempotent** — Safe to re-run.
7. **Compose with `/fix-ci`**
8. **No attribution** — Zero Attribution Policy.
<!-- skill-templates: batch-merge manual-deploy 2026-04-10 -->
