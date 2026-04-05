# Builder's Audit: CareBridge Full Platform

**Agent**: Builder — Pragmatic full-stack dev who will implement this
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-05

## Section Ratings

### 1. Infrastructure & Build — 4/5
- Turborepo, pnpm, docker-compose correctly set up
- No environment validation at startup — services fail silently if ANTHROPIC_API_KEY missing
- No Drizzle migrations committed

### 2. Database Schema & Migrations — 2/5
- Schema is well-normalized with good indexes
- **No migration files exist** — `drizzle/` directory absent — `pnpm db:migrate` fails immediately
- `clinicalRules` uses `integer` for `enabled` instead of `boolean`
- No `encounters` table despite `encounter_id` referenced across 5 tables

### 3. API Gateway — 2/5
- `services/api-gateway/src/router.ts:18` — `appRouter` only has health check
- `auth` package not listed as api-gateway dependency
- `type AppRouter = any` in frontend — type safety abandoned

### 4. Service Layer — 3/5
- clinical-data repositories are functionally correct
- All procedures use `t.procedure` (no auth context)
- `scheduling/src/router.ts` returns `[]` with `// stub` comments
- `fhir-gateway` exportPatient returns empty bundle
- `h_and_p`, `discharge`, `consult` note templates are `null` → will throw

### 5. AI Oversight — 3/5
- Architecturally sound pipeline
- **ClinicalEvent type mismatch** breaks entire pipeline (3 incompatible definitions)
- `services/ai-oversight/src/index.ts` exports `startReviewWorker` but never calls it — worker never starts
- `parseReviewResponse` silently returns `[]` on failure — no error logged

### 6. Frontend — 2/5
- 100% hardcoded mock data in clinician portal
- `type AppRouter = any` — no live tRPC calls anywhere
- "New Note", "Acknowledge", "Dismiss" buttons have no handlers
- Patient portal is 4 placeholder cards

### 7. Testing — 1/5
- Zero test files anywhere in the monorepo

## Top 5 Findings

1. **No migrations generated** — Fresh checkout fails at `pnpm db:migrate` step 1
2. **ClinicalEvent type mismatch** — 3 incompatible definitions break AI oversight end-to-end
3. **API gateway routes nothing** — `router.ts:18` only health check
4. **AI oversight worker never starts** — `index.ts` exports but never invokes `startReviewWorker()`
5. **Password hashing placeholder** — `auth/router.ts:39-47` — `"hashed:" + password`

## Estimated Effort to Working Demo

- Fix migrations + gateway + event types + worker entrypoint: ~3 days
- Real password hashing + basic RBAC + frontend data wiring: ~5 more days
- Tests, scheduling, FHIR export, missing templates: ~2-3 more weeks

## Overall Rating: 2.5/5

Good architectural bones. The gap between scaffold and working system is larger than file count suggests. Three show-stoppers block all testing: no migrations, empty gateway router, broken event type contract.
