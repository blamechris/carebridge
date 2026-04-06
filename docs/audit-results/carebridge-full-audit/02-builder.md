# Builder's Audit: CareBridge Full Codebase

**Agent**: Builder — pragmatic full-stack developer; implementability, missing components, operational gaps
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Build System / Monorepo | 4/5 | Correct DAG; no env cache-busting |
| Service Startup & Config | 2/5 | Only api-gateway has a dev script |
| Environment Variables | 3/5 | PHI key and JWT secret have no prod validation |
| Inter-Service Communication | 3/5 | 3 routers exist but are unreachable |
| Database Migrations | 4/5 | Coherent and additive |
| Frontend-Backend Connection | 3/5 | Hardcoded localhost URL |
| Seed Data & Dev Tooling | 4/5 | Thorough seed; missing env doc |
| Test Coverage | 2/5 | clinical-data/notes/patient-records have zero tests |

---

## Top 5 Findings

### Finding 1 — Critical Event Schema Mismatch: AI Oversight Receives Malformed Events

Producers (`services/clinical-data/src/events.ts:4`, `services/clinical-notes/src/events.ts:4`) emit `{ type, patientId, payload }` — camelCase fields. The consumer (`packages/shared-types/src/ai-flags.ts:93`) expects `{ id, type, patient_id, data }` — snake_case.

The review worker reads `event.patient_id` and `event.data`, both `undefined` from real events. Every AI review job produces `patient_id: undefined`. The entire AI oversight pipeline is completely broken.

**Fix:** Delete local `ClinicalEvent` types in both services; import and conform to the shared-types version.

---

### Finding 2 — AI Oversight Worker Never Starts in Dev

`pnpm dev` → `turbo dev` → only `api-gateway` starts. `services/ai-oversight/package.json` has no `dev` or `start` script (`services/ai-oversight/src/server.ts` is the entrypoint but is never executed). Clinical events pile up in Redis with no consumer.

The session cleanup worker (`services/auth/src/cleanup-worker.ts`) is exported and tested but never invoked by any running process.

**Fix:** Add `"dev": "tsx watch src/server.ts"` to `services/ai-oversight/package.json`. Call `startCleanupWorker()` from the api-gateway startup or give auth its own entrypoint.

---

### Finding 3 — RBAC Middleware Is Dead Code

`services/api-gateway/src/middleware/rbac.ts` implements a complete `assertPatientAccess()` with DB checks, cache, and audit logging. It is tested in isolation. It is **never called** from any tRPC procedure. Every patient data endpoint is effectively open to any authenticated user.

**Fix:** Wire `assertPatientAccess` into each patient-scoped tRPC procedure.

---

### Finding 4 — Three Services Exist But Are Not Reachable

`@carebridge/notifications`, `@carebridge/scheduling`, and `@carebridge/fhir-gateway` are not listed in `services/api-gateway/package.json` dependencies and not imported in `services/api-gateway/src/router.ts`. The clinician portal inbox page likely calls `trpc.notifications.*` which doesn't exist on `AppRouter`.

**Fix:** Wire the notifications router into the gateway. Delete or gate the scheduling and fhir-gateway stubs.

---

### Finding 5 — Hardcoded `localhost:4000` Blocks Any Deployed Environment

`packages/portal-shared/src/trpc.ts:23` and `:35` hardcode `http://localhost:4000/trpc`. No `NEXT_PUBLIC_API_URL` escape hatch exists. Any Docker, staging, or production deployment will fail silently.

**Fix:** Replace with `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/trpc"`. Add to `.env.example`.

---

## Key File References

| Issue | File | Line |
|---|---|---|
| ClinicalEvent mismatch | `services/clinical-data/src/events.ts` | 4–9 |
| Worker never starts | `services/ai-oversight/package.json` | (no dev script) |
| RBAC never called | `services/api-gateway/src/middleware/rbac.ts` | 131 |
| Notifications not wired | `services/api-gateway/src/router.ts` | entire file |
| Hardcoded URL | `packages/portal-shared/src/trpc.ts` | 23, 35 |
| vitest workspace gaps | `vitest.workspace.ts` | 3–8 |
| Cleanup never called | `services/auth/src/cleanup-worker.ts` | exported only |

---

## Overall Rating: 2.5/5

CareBridge has a solid architectural skeleton — the monorepo wiring, migrations, auth, and DVT seed are well-done. But three production-blocking defects make the headline feature non-functional: the `ClinicalEvent` type mismatch silently breaks all AI oversight events, the worker has no dev startup script, and the RBAC layer is never called. MVP-ready in structure, not in wiring.
