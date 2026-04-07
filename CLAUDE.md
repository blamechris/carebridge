# CareBridge

## SECURITY NOTICE — Secret Rotation Required
The `.env` file was previously tracked in git history and contained secrets
(`PHI_ENCRYPTION_KEY`, `JWT_SECRET`, `REDIS_PASSWORD`, `SESSION_SECRET`).
Although `.env` has been removed from tracking and added to `.gitignore`,
the historical contents remain in git history. All of these secrets MUST be
rotated after merging the fix for issue #135. Git history is intentionally
not rewritten to avoid destructive operations on shared branches.

## Project Overview
Healthcare platform replacing Epic MyChart. Interconnected microservice-style apps
with an AI oversight layer that catches cross-specialty clinical gaps.

Read the plan at `.claude/plans/smooth-giggling-sunset.md` for full architecture.

## Quick Start
```bash
docker-compose up -d          # PostgreSQL + Redis
pnpm install                  # Dependencies
pnpm db:migrate               # Run Drizzle migrations
pnpm db:seed                  # Seed dev data (DVT scenario patient)
pnpm dev                      # Start all services + apps
```

## Monorepo Structure
- `packages/` — Shared libraries (types, validators, medical-logic, db-schema, ai-prompts)
- `services/` — Backend services (api-gateway, clinical-notes, ai-oversight, clinical-data, patient-records, auth, notifications, fhir-gateway)
- `apps/` — Frontend apps (clinician-portal on :3000, patient-portal on :3001)
- `tooling/` — Seed data, scripts

## Tech Stack
TypeScript fullstack: Turborepo, Fastify + tRPC, Next.js 15, Drizzle ORM + PostgreSQL, BullMQ + Redis, Zod, Claude API

## Code Style
- TypeScript strict mode
- ESM (`type: "module"`, `.js` extensions in imports)
- Functional style — no classes unless necessary
- All dates as ISO 8601 strings
- UUIDs via `crypto.randomUUID()`
- Workspace packages: `@carebridge/*`

## Key Services
- **api-gateway** (port 4000): tRPC entry point, auth middleware, audit logging
- **clinical-notes**: Structured note templates (SOAP, Progress), CRUD, versioning
- **ai-oversight**: BullMQ worker, deterministic rules + Claude LLM review, clinical flag CRUD
- **clinical-data**: Vitals, labs, medications, procedures CRUD

## AI Oversight Engine
Every clinical data mutation emits to BullMQ "clinical-events" queue.
The ai-oversight worker processes events:
1. Deterministic rules (critical values, cross-specialty patterns, drug interactions)
2. LLM review via Claude API (context assembly → prompt → parse response)
3. Clinical flag generation and notification

The DVT scenario (cancer + VTE + headache → stroke risk flag) is rule ONCO-VTE-NEURO-001.

## Dev Accounts
- dr.smith@carebridge.dev (physician, Hematology/Oncology)
- dr.jones@carebridge.dev (specialist, Interventional Radiology)
- nurse.rachel@carebridge.dev (nurse, Oncology)
- patient@carebridge.dev (patient)
- Password for all: password123

## HIPAA Compliance
Audit log retention and immutability policies are documented in
`docs/hipaa-retention.md`. The `audit_log` table is append-only at the
database level (see migration `0012_audit_log_immutability.sql`) and
records are retained for 7 years.

## Git Workflow

### Zero Attribution Policy
CRITICAL: Never include ANY of the following in commits, PRs, or files:
- `Co-Authored-By: Claude` or any Claude co-author line
- `Generated with Claude Code` or similar phrases
- Any mention of Claude, Anthropic, or AI assistance

### Commit Format
```
type(scope): short summary in present tense
```
Types: feat, fix, refactor, docs, test, chore, style, perf
Scopes: db, ai, notes, clinical, auth, gateway, portal, infra
