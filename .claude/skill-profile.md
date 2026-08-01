# carebridge skill profile

## Project Context
- **Tech:** TypeScript fullstack — Turborepo monorepo, Fastify + tRPC (api-gateway), Next.js 15 + React 19 (apps), Drizzle ORM + PostgreSQL, BullMQ + Redis, Zod, Claude API (ai-oversight)
- **Repo:** blamechris/carebridge
- **Main branch:** main
- **CI:** GitHub Actions

## Merge Gate
- **Enabled:** Yes — /full-review is MANDATORY before every merge, no exceptions
- Exception: pure `.md` skill/doc files with zero code changes can skip review

## check-pr Customizations
- Copilot review IS active — keep the Step 0 polling loop. Verified via `gh api repos/blamechris/carebridge/pulls/<n>/reviews` showing copilot-pull-request-reviewer[bot] on recent PRs.
- Issue labels: `enhancement`, `bug`, `from-review`
- Code style: TypeScript strict, ESM with `.js` extensions in imports, functional style, no classes
- Evidence pattern: "per CLAUDE.md: TypeScript strict, ESM, functional style"
- Branch protection: configured with merge gate via `scripts/require-review-before-merge.sh`

## agent-review Customizations

### Persona
**CareBridge Inspector** — expert in TypeScript, Fastify, tRPC, Next.js 15, Drizzle ORM, BullMQ, Zod, healthcare data modeling, event-driven architecture, AI/LLM system design.

Mindset: "Is this type-safe end-to-end? Does it handle clinical data correctly, respect the event-driven architecture, and avoid leaking patient data?"

### Code Quality — Services (Fastify + tRPC)
- TypeScript strict, ESM (`type: "module"`, `.js` extensions in imports)
- Functional style — no classes unless absolutely necessary
- Zod validation at all service boundaries (use `@carebridge/validators`)
- All dates as ISO 8601 strings; UUIDs via `crypto.randomUUID()`
- tRPC procedures must go through `@carebridge/api-gateway` — no direct inter-service HTTP calls
- BullMQ event emission on all clinical data mutations

### Code Quality — Packages (shared libs)
- `@carebridge/shared-types` — pure types only, no runtime deps
- `@carebridge/validators` — Zod schemas only; validators must mirror shared-types
- `@carebridge/medical-logic` — pure functions, no side effects
- `@carebridge/ai-prompts` — versioned (bump `PROMPT_VERSION` on any prompt change)

### Code Quality — Apps (Next.js)
- TypeScript strict, functional components with hooks
- tRPC client via `@carebridge/clinician-portal/src/lib/trpc.ts`
- No direct database access from frontend

### Architecture
- Monorepo build order: `packages/*` → `services/*` → `apps/*`
- All clinical data mutations emit `ClinicalEvent` to Redis queue `clinical-events`
- AI oversight worker subscribes to that queue — deterministic rules first, then LLM review
- No service should import from another service directly — use tRPC via api-gateway
- `packages/db-schema` is the only place that imports `drizzle-orm` and `postgres`

### Clinical Data Rules
- Never store or log raw patient PII in non-patient-records contexts
- Clinical flags have 5 valid statuses: `open`, `acknowledged`, `resolved`, `dismissed`, `escalated`
- Rule IDs follow pattern: `DOMAIN-CONDITION-SEQ` (e.g., `ONCO-VTE-NEURO-001`)
- All AI-generated content must include rationale + suggested_action

## full-review Customizations
- Composes agent-review (CareBridge Inspector persona) + check-pr sequentially
- Copilot review IS active — agent-review's run naturally fills most of the ~4-min Copilot review delay so check-pr starts with comments waiting.
- Combined summary table is primary output

## create-pr Customizations
- Test plan should include: `pnpm typecheck` passes, `pnpm lint` passes, affected service tested locally
- Issue labels to scan: `enhancement`, `bug`, `from-review`
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/` prefixes

## create-issue Customizations
- Labels available: `enhancement`, `bug`, `from-review`
- No complexity labels yet

## learn Customizations
- **CLAUDE.md sections:** `## Key Services`, `## Code Style`, `## AI Oversight Engine`
- **Rules naming:** kebab-case (e.g., `drizzle-patterns.md`, `trpc-patterns.md`, `bullmq-patterns.md`)
- **Domain quality bar:** Drizzle ORM query patterns, tRPC router patterns, BullMQ worker lifecycle, Zod schema composition, clinical data modeling patterns qualify as durable insights
- **Common paths:** `packages/**/*.ts`, `services/**/*.ts`, `apps/**/*.tsx`

## start-working Customizations

### Ready-to-Work Labels
- Treat unblocked, unassigned `enhancement` and `bug` issues as ready
- `from-review` issues are higher priority (deferred PR feedback)

### Blocked Labels
- `blocked`, `wontfix`, `needs-design`

### Roadmap File Locations
- Default scan only (`ROADMAP.md`, `TODO.md`, `docs/`)

### Source File Patterns for TODOs
- Packages: `packages/**/*.ts`
- Services: `services/**/*.ts`
- Apps: `apps/**/*.tsx`, `apps/**/*.ts`

### Priority Signals
- `from-review` → P1
- `bug` → P0
- No milestones currently in use

### Dependency Check
- `pnpm outdated`

### Test Runner
- `pnpm typecheck && pnpm lint`

### Audit Focus Areas
- Type safety across package boundaries
- Clinical data integrity and event emission correctness
- BullMQ worker error handling and retry logic
- Zod validation coverage at API boundaries

## autonomous-dev-flow Customizations

### Self-merge posture
- **Withheld.** This repo does NOT grant unattended merge authority. Critical Rule 5
  must be written in its WITHHELD form: the session never merges, the Unattended Merge
  Gate does not apply, and every finished PR is flagged in the session report and left
  open for the user. Because there are no session merges, the skill also OMITS the
  `### Merged by this session` report section — an empty merge table reads as though a
  merge happened.
- **Why this is recorded here and not only in the skill file:** `.claude/commands/` is
  regenerated wholesale on every `skill update`, while this profile is not. Without this
  block, the next update silently takes the template's default posture (gated
  self-merge) and re-enables unattended merges on a repo that never granted them. This
  profile entry is the durable record; the command file is the derived artifact.

### Branch Prefix
- Uses `feat/` (not `auto/`) — matches existing naming conventions
- `BRANCH_PREFIX_RE` for merge/resume scans covers every prefix a session branch can
  carry: `^(feat|fix|refactor|chore|docs|test)/`

### Smoke Test
- None. There is no per-PR UI smoke-test harness and no `/smoke-test` skill in this
  repo, so the template's Phase 4.5 is dropped rather than pointed at something that
  cannot serve. `pnpm smoke-test` (`tooling/smoke-test.ts`) is a hand-maintained
  post-merge script pinned to specific merged PRs and requires a live Postgres plus
  running services — do not wire it in as a per-PR gate.

### Session Boundary Paths
- Handoff note: `$CLAUDE_BRIEF_DIR/../handoffs/carebridge-<YYYY-MM-DD>-handoff.md`
- Durable queue: `$CLAUDE_BRIEF_DIR/../handoffs/carebridge-<YYYY-MM-DD>-queue.json`
- Both live outside the repo — `scratchpad/` is not in this repo's `.gitignore`, so an
  in-tree queue file would surface in `git status`
- Wave re-launcher: none configured (no cron entry, no LaunchAgent, no `/loop` wrapper)
- Cost source: the statusline (`cost.total_cost_usd`). No per-session budget is set, so
  the circuit breaker fires only against a budget named at invocation

### Decomposition Trigger
- Treat issues touching 3+ packages/services as decomposition candidates

### Test Runners
- Type check: `pnpm typecheck`
- Lint: `pnpm lint`
- Full: `pnpm typecheck && pnpm lint`

### Commit Scopes
- `db`, `ai`, `notes`, `clinical`, `auth`, `gateway`, `portal`, `infra`

### PR Test Plan
- `- [ ] pnpm typecheck passes`
- `- [ ] pnpm lint passes`
- `- [ ] Affected service tested locally`

## decompose-issue Customizations
- Default sub-issue labels: `enhancement`, `bug`, or `from-review` matching the parent's primary label. No `complexity:*` labels in this repo yet — skip them.
- Parent-link convention: body line "Part of #N" only — no `parent:#N` label scheme.
- Parent-marker label: none currently. Skip the parent-marker step.
- Natural seams follow the Turborepo build order: `packages/*` (shared types, validators, medical-logic, ai-prompts, db-schema) → `services/*` (api-gateway, ai-oversight, clinical workers) → `apps/*` (clinician-portal). Prefer one sub-issue per layer when an issue spans two or more.
- Other axes: commit scopes (`db`, `ai`, `notes`, `clinical`, `auth`, `gateway`, `portal`, `infra`) — each is a candidate sub-issue boundary. Clinical-data event-emission changes always need a sub-issue separate from the producer and consumer to make the contract review-able in isolation.

## parallel-dev Customizations

Shares all customization points with `autonomous-dev-flow` above.

### Parallel-Specific Settings
- **Default concurrency:** 3
- **Dependency setup in worktree:** `pnpm install` (Turborepo monorepo — each worktree needs its own node_modules)

## merge Customizations

### Review Gate
- /full-review is MANDATORY before every merge — hard gate, no exceptions
- Exception: pure `.md` skill/doc files with zero code changes

### Merge Strategy
- Always `--squash --delete-branch`

### Auto-Version
- None configured yet

### Post-Merge Steps
- None required currently (no native builds)

## swarm-audit Customizations

### Domain-Specific Extended Agents

| Agent | Nickname | Lens | When to Include |
|-------|----------|------|-----------------|
| Healthcare Data Architect | "Chart Keeper" | FHIR R4, ICD-10/CPT codes, clinical data modeling, EHR interoperability, HIPAA-adjacent patterns | Target involves patient data schema, clinical data structures, FHIR gateway, or data migration |
| AI Safety Inspector | "Oversight" | LLM prompt safety, hallucination risk in clinical contexts, prompt injection, Claude API response validation, deterministic rule coverage | Target involves ai-oversight service, clinical rules engine, prompts, or flag generation logic |

### Grading Criteria
- Operator should weight data integrity: are clinical events correctly emitted and consumed?
- Guardian should weight type safety: are package boundary contracts enforced end-to-end?
- Expert agents should verify claims against Drizzle ORM and tRPC documentation

## tackle-issues Customizations
- Max concurrent: 3 (monorepo, parallel package builds safe)
- Priority labels: `bug` > `from-review` > `enhancement`
- Test gate: `pnpm typecheck && pnpm lint`
- Session ledger: `$CLAUDE_BRIEF_DIR/../handoffs/carebridge-<YYYY-MM-DD>-session-ledger.md`
  — kept outside the repo (nothing at the repo root is gitignored for it)

### Self-merge posture
- **Withheld.** This repo does NOT grant unattended merge authority. Critical Rule 5
  must be written in its WITHHELD form: nothing merges inline during waves, the
  Unattended Merge Gate never engages, `merge:on` is NOT honoured (an invocation flag
  cannot grant authority the repo withholds), and `merge:off` is redundant rather than
  required. Every PR accumulates for `/batch-merge` or user review. Because there are no
  session merges, the Morning Summary also OMITS the `### Merged by this session`
  section — an empty merge table reads as though a merge happened.
- **Why this is recorded here and not only in the skill file:** `.claude/commands/` is
  regenerated wholesale on every `skill update`, while this profile is not. Without this
  block, the next update silently takes the template's default posture (gated
  self-merge) and re-enables unattended merges on a repo that never granted them. This
  profile entry is the durable record; the command file is the derived artifact.

## fix-ci Customizations
- CI config: `.github/workflows/`
- Test commands: `pnpm typecheck`, `pnpm lint`, `pnpm build`
- Common failures: TypeScript strict violations, missing `.js` extensions in ESM imports, Drizzle schema drift
