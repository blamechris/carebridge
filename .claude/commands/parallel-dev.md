# /parallel-dev

Orchestrate parallel autonomous dev sessions — dispatch multiple agents into isolated worktrees to implement GitHub issues with TDD simultaneously, then run sequential reviews. Each agent works independently in its own worktree, eliminating branch conflicts.

## Arguments

- `$ARGUMENTS` - Issue source and options. Examples:
  - `label:ready-to-build` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - `label:ready-to-build parallel:4` (with concurrency override)
  - If empty, auto-detect: scan open issues sorted by complexity (low first, then medium, skip high)
  - Options: `max:N` (default 8, hard cap 10), `parallel:N` (default 3, max 5), `sort:created-asc` (default) or `sort:created-desc`

## Instructions

### Phase 0: Queue Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

BRANCH_PREFIX="feat/"
PARALLEL=3
```

Parse arguments. Filter assigned issues. Check for existing branches/PRs. Validate queue. Show user queue with batch assignments. Wait for confirmation (**only confirmation point**).

### Phase 0.5: Auto-Decompose High-Complexity Issues

Decompose issues touching 3+ packages/services into 2-5 sub-issues before dispatching agents.

### Phase 1: Build Agent Prompts

1. Read CLAUDE.md once
2. Sync to latest main
3. Fetch each issue's full details
4. Build self-contained prompt for each agent

### Phase 2: Parallel Implementation (Fan-Out)

Launch agents with `isolation: "worktree"`. Process in batches of `PARALLEL`.

Each agent independently:
1. Installs dependencies: `pnpm install`
2. Reads issue and explores code
3. Creates branch: `feat/${ISSUE_NUM}-${SLUG}`
4. Implements with TDD (RED → GREEN → REFACTOR)
5. Runs `pnpm typecheck && pnpm lint`
6. Commits (scopes: `db`, `ai`, `notes`, `clinical`, `auth`, `gateway`, `portal`, `infra`)
7. Pushes, creates PR with test plan:
   - `- [ ] pnpm typecheck passes`
   - `- [ ] pnpm lint passes`
   - `- [ ] Affected service tested locally`

**IMPORTANT:** Run agents as foreground calls, NOT background.

### Phase 3: Collect Results (Fan-In)

Parse each agent's output. Build interim progress table.

### Phase 4: Sequential Review Pipeline

For each PR (sequentially):
1. Pre-Skill Checkpoint — re-read CLAUDE.md and skill files
2. Run `/full-review ${PR_NUM}`
3. Classify verdict (Clean / Needs attention / Broken)
4. Two fix attempts max

### Phase 5: Session Summary

Final summary with all results, needs attention items, failed issues, next steps including `/batch-merge` command.

## Resume Strategy

Uses **GitHub state** for resume. Idempotent and safe to re-run.

## Critical Rules

1. **NO attribution** — Zero Attribution Policy.
2. **TDD is mandatory**
3. **Branch from main**
4. **One confirmation point**
5. **Never merge**
6. **Reviews run sequentially**
7. **Two fix attempts max**
8. **Hard cap 10 issues**
9. **Max 5 concurrent agents**
10. **Agents are fully independent**
11. **Decomposition before fan-out**
12. **Failed agents don't block**
13. **Comment on skips**
14. **Pre-Skill Checkpoint** before each /full-review
15. **Compose existing skills**
<!-- skill-templates: parallel-dev manual-deploy 2026-04-10 -->
