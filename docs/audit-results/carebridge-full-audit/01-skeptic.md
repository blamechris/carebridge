# Skeptic's Audit: CareBridge Full Codebase

**Agent**: Skeptic — cynical systems engineer; claims vs. reality, what won't work
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Auth System | 4/5 | Solid primitives; 3 real gaps |
| API Gateway | 3/5 | RBAC defined but never enforced |
| AI Oversight Engine | 2/5 | Core pipeline broken by type mismatch |
| Clinical Data Services | 2/5 | No RBAC + broken event schema |
| Frontend Portals | 3/5 | Functional; MFA locked out from UI |
| Database Schema & Migrations | 4/5 | Strong; date-as-text is fragile |
| Shared Packages | 3/5 | PHI sanitizer unused; scheduling is a stub |

---

## Top 5 Findings

### Finding 1 — RBAC is Defined but Never Enforced
`assertPatientAccess` and `assertCareTeamAccess` in `services/api-gateway/src/middleware/rbac.ts` are tested in isolation but called by **zero** production routers. `services/patient-records/src/router.ts`, `services/clinical-data/src/router.ts`, and `services/clinical-notes/src/router.ts` all use raw `t.procedure` with no care-team check.

Any authenticated user can read or write vitals, medications, notes, and patient records for any patient. Directly violates HIPAA minimum-necessary.

**Fix:** Create a `patientProcedure` tRPC middleware that calls `assertPatientAccess` and apply it to every patient-scoped endpoint.

---

### Finding 2 — Three Incompatible `ClinicalEvent` Types Silently Break AI Oversight

- `services/clinical-data/src/events.ts:4`: `{ type, resourceId, patientId, payload }`
- `services/clinical-notes/src/events.ts:4`: `{ type, noteId, patientId, providerId, payload }`
- `packages/shared-types/src/ai-flags.ts:93`: `{ id, type, patient_id, data }`

The worker at `services/ai-oversight/src/workers/review-worker.ts:26` reads `event.patient_id`, `event.id`, and `event.data` — all `undefined` when events arrive from clinical-data or clinical-notes. No rules fire. No LLM context is assembled. The AI oversight pipeline produces nothing.

**Fix:** Delete local `ClinicalEvent` interfaces in both services; import from `@carebridge/shared-types`.

---

### Finding 3 — `createUser` is Public — Privilege Escalation is One API Call Away

`services/auth/src/router.ts:457` exposes `createUser` as a `publicProcedure`. The schema accepts a `role` field. An unauthenticated caller can create an `admin` account via a single POST.

**Fix:** Gate behind an `admin`-only check immediately.

---

### Finding 4 — TOTP Codes Can Be Replayed Within the 30-Second Window

`services/auth/src/totp.ts:91-110` verifies correctly but stores no used-code state. A just-accepted code remains valid for ~30 more seconds.

**Fix:** Store `(secret_id, counter)` in Redis with 90-second TTL after successful verification.

---

### Finding 5 — PHI Sanitizer Package Exists but No PHI Is Sanitized Before Reaching Claude API

`packages/phi-sanitizer` contains a working redactor. Zero services import it. `services/ai-oversight/src/workers/context-builder.ts:163-168` includes full care team member names and diagnosis strings verbatim in the LLM prompt.

**Fix:** Apply `redactProviderNames` and `sanitizeFreeText` to context builder output before `buildReviewPrompt` in `review-service.ts:109`.

---

## Overall Rating: 2.5/5

CareBridge has solid security primitives in the auth layer but the system has critical operational failures: RBAC exists only in tests, the AI oversight event pipeline is broken by three divergent type definitions, PHI flows unredacted to an external API, and account creation is publicly accessible with arbitrary role assignment. The bones are good. The wiring is not done.
