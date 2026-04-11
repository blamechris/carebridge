# /tackle-issues

Run an unattended marathon session that works through GitHub issues across multiple waves until convergence — all issues are resolved, or all remaining issues are genuinely blocked. Designed to maximize overnight/extended usage windows.

Composes `/autonomous-dev-flow` logic internally but adds multi-wave retry with escalating strategies, dynamic queue replenishment, and a morning summary.

## Arguments

- `$ARGUMENTS` - Issue source and options. Same as `/autonomous-dev-flow` plus marathon-specific options:
  - `label:ready-to-build` (all open issues with this label)
  - `milestone:"v1.2"` (all open issues in milestone)
  - `#12 #15 #18` or `12 15 18` (specific issues by number)
  - If empty, auto-detect: scan open issues sorted by complexity (low first, then medium, skip high)
  - Options: `max:N` (default 20, hard cap 30), `sort:created-asc` (default) or `sort:created-desc`
  - `waves:N` (default 3, max 4) — maximum retry waves
  - `merge:true` — run `/batch-merge all` after final wave (default: false)

## Instructions

### Wave Model Overview

```
Wave 1 (Fresh Pass)    → Attempt all queued issues using standard approach
                           ↓ replenish queue (sub-issues, new labeled issues)
Wave 2 (Retry)         → Re-attempt failed/flagged issues with fresh context
                           ↓ replenish queue
Wave 3 (Alt Strategy)  → Re-attempt remaining failures with alternative approaches
                           ↓ convergence check
Wave 4 (Final Sweep)   → Last attempt on anything still open (optional, if waves:4)
                           ↓
Morning Summary        → Structured report of everything that happened
```

### Phase 0: Marathon Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
SESSION_START=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Branch prefix
BRANCH_PREFIX="feat/"
```

Parse arguments. Build initial queue. Priority labels: `bug` > `from-review` > `enhancement`.

Display marathon queue. Wait for user confirmation. **This is the ONLY confirmation point.**

### Phase 1: Execute Wave

For each issue, run the full `/autonomous-dev-flow` Phases 1-6 cycle. Two fix attempts per issue per wave. Track failure reasons.

Test gate: `pnpm typecheck && pnpm lint`

### Phase 2: Queue Replenishment (Between Waves)

Collect retry candidates, scan for new issues, check for user merges, clean up failed branches, build next wave queue.

### Phase 3: Retry Strategy Escalation

- **Wave 2:** Fresh context retry — re-read issue, read failed PR review comments, start fresh
- **Wave 3:** Alternative approach — different architecture, simplified scope, minimum viable version
- **Wave 4:** Final sweep (optional)

### Phase 4: Convergence Detection

Stop when: all done/skipped, zero progress in last wave, all retries exhausted, or queue empty.

### Phase 5: Optional Batch Merge

If `merge:true`, run `/batch-merge` on clean PRs.

### Phase 6: Morning Summary

Comprehensive report: results overview, all PRs created, needs attention, blocked issues, skipped issues, wave-by-wave summary, next steps.

## Resume Strategy

Uses **GitHub state** for resume. Idempotent and safe to re-run.

## Critical Rules

1. **NO attribution** — Zero Attribution Policy.
2. **TDD is mandatory**
3. **Branch from main every time**
4. **One confirmation point**
5. **Never merge (unless merge:true)**
6. **Clean up failed attempts** — Close old PRs, delete old branches before retrying.
7. **Escalate strategy across waves**
8. **Converge, don't loop forever**
9. **Progress table after every issue**
10. **Respect the hard cap** — Max 30 issues.
11. **Resume from GitHub state**
12. **Compose existing skills**
13. **Decompose in Wave 1 only**
14. **Comment on blocked issues**
15. **Pre-Skill Checkpoint** before /full-review.
16. **Sync before every branch**
17. **Morning summary is mandatory**
<!-- skill-templates: tackle-issues manual-deploy 2026-04-10 -->
