# Master Assessment: CareBridge Full Codebase Swarm Audit

**Date**: 2026-04-06
**Branch**: `claude/sleepy-hellman`
**Agents**: 6 (4 core, 2 extended)
**Aggregate Rating**: **2.5 / 5**

---

## a. Auditor Panel

| Agent | Perspective | Rating | Key Contribution |
|---|---|---|---|
| Skeptic | Claims vs. reality | 2.5/5 | Found RBAC never enforced; event type mismatch; createUser public |
| Builder | Implementability & wiring | 2.5/5 | AI oversight worker never starts; 3 services unreachable; localhost hardcoded |
| Guardian | Security/SRE/HIPAA | 2.5/5 | CORS wildcard+credentials; dev auth bypass; no BullMQ DLQ; no login rate limit |
| Minimalist | Complexity reduction | 2.5/5 | Homegrown JWT/TOTP; 2 dead services; phi-sanitizer built but never connected |
| Oversight | LLM/AI safety | 2.5/5 | PHI flows unredacted to Claude; LLM output not validated; dedup broken cross-job |
| Chart Keeper | FHIR/clinical data | 2.5/5 | FHIR export returns empty Bundle; no LOINC codes; patient name in plaintext |

---

## b. Consensus Findings (5/6+ agents agree)

### C1 — `ClinicalEvent` type mismatch breaks the entire AI oversight pipeline
**Agreed by:** Skeptic, Builder, Minimalist, Oversight (4/6)

Three incompatible `ClinicalEvent` definitions exist for the same BullMQ queue. Producers use camelCase (`patientId`, `payload`); the consumer expects snake_case (`patient_id`, `data`). Every real clinical event arrives at the AI oversight worker with `patient_id: undefined`, `data: undefined`. No rules fire. No LLM context is assembled. No flags are generated. The system's primary safety feature is silently non-functional.

**Fix:** Delete local `ClinicalEvent` types in `services/clinical-data/src/events.ts` and `services/clinical-notes/src/events.ts`. Import `ClinicalEvent` from `@carebridge/shared-types`.

---

### C2 — RBAC middleware is fully implemented but never called — any authenticated user can access any patient's data
**Agreed by:** Skeptic, Builder, Guardian (3/6 core agents, high-severity consensus)

`assertPatientAccess()` and `assertCareTeamAccess()` in `services/api-gateway/src/middleware/rbac.ts` are complete, cached, and tested. They are called by zero production routers. Every endpoint in `patient-records`, `clinical-data`, and `clinical-notes` uses raw `t.procedure` with no access check. A logged-in nurse can read or write vitals for any patient in the system, regardless of care team assignment. Direct HIPAA minimum-necessary violation.

**Fix:** Wire `assertPatientAccess` into every patient-scoped tRPC procedure.

---

### C3 — PHI sanitizer package is complete and tested but not connected to the AI pipeline
**Agreed by:** Skeptic, Minimalist, Oversight, Guardian (4/6)

`@carebridge/phi-sanitizer` has a working redactor (`redactClinicalText`, `bandAge`, `sanitizeFreeText`) and an LLM response validator (`validateLLMResponse`). Neither is imported by the ai-oversight service (absent from its `package.json`). PHI — including full patient names, provider names, diagnosis strings, and raw event data — flows verbatim to the external Anthropic API. Claude's output is parsed with a minimal key-presence check (`"severity" in item`) and persisted directly to the clinical record with no validation of enum values, field lengths, or array size.

**Fix:** Add `@carebridge/phi-sanitizer` to ai-oversight dependencies. Call `redactClinicalText()` before sending to Claude. Replace `parseReviewResponse()` with `validateLLMResponse()` in `review-service.ts`.

---

### C4 — `createUser` is a public, unauthenticated endpoint accepting any role including admin
**Agreed by:** Skeptic, Guardian (2/6, but severity is critical/unanimous)

`services/auth/src/router.ts:457` exposes `createUser` as a `publicProcedure`. The schema accepts a `role` field. An unauthenticated caller can POST to `/trpc/auth.createUser` with `{ role: "admin" }` and receive a valid admin account.

**Fix:** Gate behind an `requireRole('admin')` middleware immediately.

---

### C5 — API gateway URL hardcoded to `localhost:4000` — no deployed environment can work
**Agreed by:** Builder, Minimalist (2/6, unanimous among portal-focused agents)

`packages/portal-shared/src/trpc.ts:23,35` hardcodes `http://localhost:4000/trpc`. No `NEXT_PUBLIC_API_URL` env var escape hatch. Docker, staging, Kubernetes, Vercel — all fail silently.

**Fix:** `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/trpc"`. Add to `.env.example`.

---

## c. Contested Points

### Point 1: Custom JWT/TOTP vs. battle-tested libraries

**Minimalist:** Replace `services/auth/src/jwt.ts` (101 lines) and `services/auth/src/totp.ts` (172 lines) with `jose` and `otpauth`. Custom crypto is liability code.

**Guardian:** The current implementation is functionally correct (timing-safe HMAC comparison, proper RFC 6238 TOTP with drift tolerance). The risk of bugs introducing exploits is real but the code is auditable. The greater risk is the *operational* gap (no Redis-backed state for MFA sessions/rate limits), not the library choice itself.

**Resolution:** Prefer using vetted libraries (`jose`, `otpauth`) but deprioritize below the critical security gaps. Custom implementation has no known bugs; replacing it is a low-urgency correctness investment.

---

### Point 2: Whether the BullMQ session cleanup worker is over-engineered

**Minimalist:** `services/auth/src/cleanup-worker.ts` uses BullMQ to schedule a periodic session cleanup job — adds Redis as a hard dependency to the auth service for a task that `setInterval` or `pg_cron` could handle trivially.

**Guardian:** Session cleanup is a recurring task that needs exactly the properties BullMQ provides: reliable scheduling, exactly-once execution across instances, and visibility into execution history. A `setInterval` would fire on every replica simultaneously, causing N concurrent cleanup queries.

**Resolution:** `pg_cron` (single scheduled task in the DB layer) is the cleanest solution at current scale. BullMQ is not wrong, but is heavy. Either way, the cleanup worker is never invoked — that is the actual bug.

---

## d. Factual Corrections

| Claim | Reality |
|---|---|
| "AI oversight catches cross-specialty clinical gaps" (CLAUDE.md) | The AI oversight pipeline is silently non-functional due to `ClinicalEvent` type mismatch; no flags are generated from real events |
| "RBAC enforces HIPAA minimum-necessary access" (code comments in rbac.ts) | `assertPatientAccess()` is never called by any production procedure |
| "PHI is sanitized before reaching the LLM" (implied by phi-sanitizer package existence) | `@carebridge/phi-sanitizer` is not a dependency of ai-oversight; zero PHI sanitization occurs |
| "pnpm dev starts all services" (CLAUDE.md Quick Start) | Only `api-gateway`, `clinician-portal`, and `patient-portal` have `dev` scripts; `ai-oversight` worker never starts |
| "FHIR gateway exports patient data" (service name implies) | `exportPatient` always returns `{ entry: [] }` — an empty hardcoded Bundle |
| "MFA is available in the clinician portal" (backend implementation exists) | Frontend shows `"MFA login flow coming soon."` — MFA is backend-only, UI inaccessible; enabling MFA locks users out |

---

## e. Risk Heatmap

```
Impact
  HIGH │ C2:RBAC    C1:Events  C3:PHI/LLM │
       │ (any auth  (AI over-  (PHI sent  │
       │  sees all   sight     unredacted)│
       │  patients)  silent)              │
       │                                  │
  MED  │ CORS:open  No DLQ    createUser  │ API URL
       │ (+creds)   (lost      public     │ hardcoded
       │            flags)                │
       │                                  │
  LOW  │ name       LOINC     TOTP        │ temp in °F
       │ plaintext  absent    replay      │ no SNOMED
       └──────────────────────────────────┘
           LOW         MED         HIGH
                     Likelihood
```

**Top-right quadrant (High impact, High likelihood):**
- C1: ClinicalEvent type mismatch (already happening on every event)
- C2: RBAC not enforced (every request by any user)
- C3: PHI unredacted to Claude API (every AI review job)

---

## f. Recommended Action Plan

### P0 — Do These Before Any Real Patient Data Touches the System

| # | Action | Files | Effort |
|---|---|---|---|
| 1 | Fix `ClinicalEvent` type mismatch — unify on `@carebridge/shared-types` version | `services/clinical-data/src/events.ts`, `services/clinical-notes/src/events.ts` | 1 hour |
| 2 | Wire `assertPatientAccess` into all patient-scoped tRPC procedures | `services/patient-records`, `services/clinical-data`, `services/clinical-notes` routers | 2 hours |
| 3 | Add `@carebridge/phi-sanitizer` to ai-oversight; call `redactClinicalText` before Claude; replace `parseReviewResponse` with `validateLLMResponse` | `services/ai-oversight/src/services/review-service.ts` | 2 hours |
| 4 | Gate `createUser` behind admin-only check | `services/auth/src/router.ts:457` | 30 min |
| 5 | Fix CORS — replace `?? true` with explicit allowlist; fail-closed in production | `services/api-gateway/src/server.ts:22` | 30 min |
| 6 | Remove dev auth bypass header or gate on explicit `ALLOW_DEV_HEADER=true` | `services/api-gateway/src/middleware/auth.ts:43-86` | 1 hour |

### P1 — Fix Before Beta / Any External Access

| # | Action | Files | Effort |
|---|---|---|---|
| 7 | Add BullMQ retry config (`attempts: 5`, exponential backoff) and `removeOnFail` | `services/clinical-data/src/events.ts`, `services/ai-oversight/src/workers/review-worker.ts` | 1 hour |
| 8 | Move MFA rate-limit state and pending MFA sessions to Redis | `services/auth/src/router.ts:77-80`, `services/auth/src/mfa-rate-limit.ts` | 3 hours |
| 9 | Add `@fastify/rate-limit` to login endpoint and API gateway | `services/api-gateway/src/server.ts` | 1 hour |
| 10 | Add auth middleware to AI oversight router | `services/ai-oversight/src/router.ts:21` | 1 hour |
| 11 | Encrypt `patients.name`; add `name_hmac` for searchability | `packages/db-schema/src/schema/patients.ts` + new migration | 2 hours |
| 12 | Add dev script to `ai-oversight`; start `cleanupWorker` | `services/ai-oversight/package.json`, `services/api-gateway/src/server.ts` | 30 min |
| 13 | Parameterize API URL; add `NEXT_PUBLIC_API_URL` | `packages/portal-shared/src/trpc.ts:23,35` | 30 min |
| 14 | Hash `refresh_token` before DB storage (store HMAC) | `packages/db-schema/src/schema/auth.ts:26`, `services/auth/src/router.ts` | 2 hours |
| 15 | Add login rate limiting (Redis-backed) | `services/auth/src/router.ts` | 2 hours |

### P2 — Quality / Compliance Debt

| # | Action | Files | Effort |
|---|---|---|---|
| 16 | Add LOINC codes to vitals schema + seed data | `packages/db-schema/src/schema/clinical-data.ts` + migration | 3 hours |
| 17 | Wire notifications/fhir-gateway routers into api-gateway or delete stubs | `services/api-gateway/src/router.ts` | 1 hour |
| 18 | Delete `packages/fhir-utils` stub and `services/scheduling` stub | Various | 30 min |
| 19 | Fix flag deduplication — add DB uniqueness check in `createFlag` | `services/ai-oversight/src/services/flag-service.ts` | 2 hours |
| 20 | Add ICD-10 format validation regex to validators | `packages/validators/src/clinical-data.ts` | 1 hour |
| 21 | Add SNOMED codes to `diagnoses` table | `packages/db-schema/src/schema/patients.ts` + migration | 2 hours |
| 22 | Fix N+1 queries in context-builder (2 loops → 2 `inArray` queries) | `services/ai-oversight/src/workers/context-builder.ts:139-169` | 1 hour |
| 23 | Replace custom JWT/TOTP with `jose` + `otpauth` | `services/auth/src/jwt.ts`, `services/auth/src/totp.ts` | 4 hours |
| 24 | Implement FHIR resource generators in fhir-gateway | `services/fhir-gateway/src/router.ts` | 1 week |
| 25 | Fix `date_of_birth` validator from `datetime()` to `date()` | `packages/validators/src/patient.ts:7` | 30 min |

---

## g. Final Verdict

**Aggregate Rating: 2.5 / 5**
*(Core panel: 4 agents × 1.0x weight, avg 2.5; Extended panel: 2 agents × 0.8x weight, avg 2.5)*

CareBridge has a well-conceived architecture and several production-quality components: the AES-256-GCM field-level PHI encryption with key rotation, scrypt password hashing, HMAC-indexed encrypted MRN, JWT session tokens with DB-backed revocation, TOTP MFA, and the DVT scenario seed are all genuinely solid work. The codebase reflects serious intent about clinical safety and HIPAA compliance.

However, the system has three production-blocking failures that make its headline feature — cross-specialty AI oversight catching DVT/stroke risk — **silently non-functional** in its current state. Every clinical event emitted by `clinical-data` or `clinical-notes` arrives at the AI oversight worker with `patient_id: undefined` due to a type mismatch that has been in the codebase since the initial commit. The AI oversight worker also never starts with `pnpm dev`. The RBAC layer — carefully implemented with care-team scoping, 60-second TTL caching, and audit logging — is called by zero production procedures, making every patient record accessible to any authenticated user. And the PHI sanitizer — built, tested, and ready — sits unused while full patient context flows unredacted to the external Claude API on every review job.

The system is **not ready for production** and should not process real patient data until at minimum the P0 items above are addressed. With those 6 fixes, it would be a solid foundation. Without them, it is a system that looks complete from the outside but produces no AI clinical flags and enforces no access control.

---

## h. Appendix — Individual Reports

| Agent | File | Rating |
|---|---|---|
| Skeptic | [01-skeptic.md](./01-skeptic.md) | 2.5/5 |
| Builder | [02-builder.md](./02-builder.md) | 2.5/5 |
| Guardian | [03-guardian.md](./03-guardian.md) | 2.5/5 |
| Minimalist | [04-minimalist.md](./04-minimalist.md) | 2.5/5 |
| Oversight | [05-oversight.md](./05-oversight.md) | 2.5/5 |
| Chart Keeper | [06-chart-keeper.md](./06-chart-keeper.md) | 2.5/5 |
