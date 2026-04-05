# Skeptic's Audit: CareBridge Full Platform

**Agent**: Skeptic — Cynical systems engineer who cross-references every claim against actual code
**Overall Rating**: 2 / 5
**Date**: 2026-04-05

## Section Ratings

### 1. Authentication & Session Management — 2/5
- Plaintext passwords: `services/auth/src/router.ts:39-47` — `"hashed:" + password`
- Dev bypass is `NODE_ENV !== "production"`: any misconfigured env bypasses auth
- `ROLE_PERMISSIONS` defined in `packages/shared-types/src/auth.ts:38-73` but never checked anywhere
- `createUser` is a `publicProcedure` — anyone can self-register as admin

### 2. API Gateway — 1/5
- `services/api-gateway/src/router.ts:18` — `mergeRouters(healthRouter)` — the entire clinical API is unreachable
- All service routers are orphaned; no client can reach clinical data through port 4000
- Audit log maps HTTP methods but all tRPC is POST — every read is logged as "create"

### 3. AI Oversight — 3/5
- DVT rule requires `new_symptoms` in event data; vital events have no symptom fields
- `ClinicalEvent` type is defined differently in 3 places — worker receives `patientId` but accesses `patient_id` → undefined
- BullMQ concurrency=5 with no DLQ; clinical events are silently dropped on worker failure

### 4. Clinical Data — 3/5
- No authorization on any mutation — patient-role can prescribe medications
- `getLatestVitals` fetches ALL vitals in memory
- Context builder N+1 queries for lab results and care team

### 5. FHIR Gateway — 1/5
- Three stubs. `patient_id` is always null on import. `exportPatient` returns `entry: []`
- Notifications never triggered from flags

## Top 5 Findings

1. **API gateway routes nothing** — `services/api-gateway/src/router.ts:18` — platform is completely non-functional end-to-end
2. **Passwords stored as recoverable plaintext** — `services/auth/src/router.ts:39-47`
3. **RBAC declared but never enforced** — `packages/shared-types/src/auth.ts:38-73` vs. every service router
4. **ClinicalEvent type mismatch** — `services/clinical-data/src/events.ts` vs `packages/shared-types/src/ai-flags.ts` — AI oversight pipeline is broken
5. **Critical flags never notify anyone** — `services/ai-oversight/src/services/flag-service.ts` creates flags but nothing triggers notifications

## Overall Rating: 2/5

CareBridge presents a coherent vision but does not function as a connected system. The API gateway routes nothing. The event schema mismatch breaks AI oversight before it reaches rules. Passwords use a string prefix. RBAC is decorative. Critical flags generate no notifications. Every one of these is a production-blocking defect for a healthcare platform.
