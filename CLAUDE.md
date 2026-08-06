# CareBridge

## Security note — 2026-04 `.env` exposure: investigated & closed (2026-08-05)
A notice here previously mandated rotating `PHI_ENCRYPTION_KEY`, `JWT_SECRET`,
`REDIS_PASSWORD`, and `SESSION_SECRET` after `.env` was believed tracked in git
history. A full forensic sweep (2026-08-05) found no tracked `.env` in any
retrievable history and no real-shaped secret ever committed; the risk was
accepted and the secrets were not rotated. The complete investigation record —
including the conditions under which rotation becomes mandatory — is the final
comment on issue #135. Rotation procedure, if ever needed: `docs/phi-key-rotation.md`.

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

`pnpm dev` runs `tsc --watch` for every workspace library package alongside
`tsx watch` for each service. Editing `src/` in any `@carebridge/*` package
rebuilds its `dist/` and the consuming service hot-reloads automatically.
(If you ever see a fix that's on disk but isn't taking effect at runtime,
check that the package's `dist/` mtime is newer than its `src/` — that
contract being broken is the root cause #1264 was filed to prevent.)

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
