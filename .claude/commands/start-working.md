# /start-working

Scan all work sources — GitHub issues, open PRs, roadmap files, audit outputs, codebase TODOs — to determine what to work on next. If nothing actionable is found, perform a lightweight codebase audit to surface potential investigations.

This skill is **read-only** — it never writes files, creates issues, or commits. It's a triage tool that feeds naturally into `/autonomous-dev-flow` or manual work.

## Arguments

- `$ARGUMENTS` - Optional filters: `focus=AREA`, `limit=N` (default 10), `include-closed`

## Instructions

### 0. Setup

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
```

Read CLAUDE.md and `.claude/rules/` files.

### 1. Gather Work Sources

#### 1a. GitHub Issues

Categorize open issues:
- **Blocked:** Has label `blocked`, `wontfix`, `needs-design`, `on-hold`
- **Assigned:** Has assignees
- **Ready:** Unblocked, unassigned `enhancement` and `bug` issues; `from-review` issues are higher priority
- **Backlog:** Open, unassigned, not blocked, no explicit "ready" signal

#### 1b. Open PRs Needing Attention

Flag: `CHANGES_REQUESTED`, `isDraft: true`, stale (7+ days), failing CI.

#### 1c. Roadmap and Planning Files

Scan `ROADMAP.md`, `TODO.md`, `docs/` for unchecked items and planned work.

#### 1d. Audit Output Files

Check `docs/project-audit/`, `docs/audits/`, open `from-audit` and `from-review` issues.

#### 1e. Codebase TODOs

Scan for TODO/FIXME/HACK markers in:
- `packages/**/*.ts`
- `services/**/*.ts`
- `apps/**/*.tsx`, `apps/**/*.ts`

### 2. Prioritize and Deduplicate

| Tier | Label | Signals |
|------|-------|---------|
| P0 | Immediate | PRs with `CHANGES_REQUESTED`, open `bug` issues, failing CI |
| P1 | High | `from-review` issues, milestone-assigned issues, stale PRs |
| P2 | Normal | `enhancement` issues with acceptance criteria, `from-audit` issues, roadmap items |
| P3 | Exploratory | Codebase TODOs, vague issues, audit recommendations without issues |

### 3. Present Work Queue

Primary output table + detail sections + recommended next action with copy-pasteable commands.

### 4. Quick Audit (Fallback — Only If Queue Is Empty)

Test runner: `pnpm typecheck && pnpm lint`
Dependency check: `pnpm outdated`

Audit focus areas:
- Type safety across package boundaries
- Clinical data integrity and event emission correctness
- BullMQ worker error handling and retry logic
- Zod validation coverage at API boundaries

## Critical Rules

1. **Read-only** — NEVER writes files, creates issues, creates PRs, or commits.
2. **Quick, not deep** — Under 2 minutes for Phases 1-3.
3. **Prioritize actionability**
4. **Deduplicate across sources**
5. **Graceful degradation**
6. **Respect blocked/assigned**
7. **Composable output** — Include copy-pasteable commands.
8. **No file writes**
<!-- skill-templates: start-working manual-deploy 2026-04-10 -->
