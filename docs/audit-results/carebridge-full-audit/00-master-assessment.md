# Master Assessment: CareBridge Platform Swarm Audit

**Target:** CareBridge full platform (entire codebase)
**Agents:** 8 (Skeptic, Guardian, Builder, Minimalist, Adversary, Chart Keeper, Oversight, HIPAA Expert)
**Date:** 2026-04-05
**Aggregate Rating:** **2.0 / 5**

---

## Auditor Panel

| Agent | Lens | Rating | Key Contribution |
|---|---|---|---|
| Skeptic | Claims vs. code reality | 2.0 | Gateway routes nothing; event type mismatch breaks AI pipeline |
| Guardian | Safety, failure modes, data integrity | 1.5 | Auth bypass one header away; all clinical data publicly accessible |
| Builder | Implementability, missing pieces | 2.5 | No migrations; worker never starts; frontend 100% mock data |
| Minimalist | YAGNI, complexity, simplification | 2.5 | 9 fake microservices; fhir-utils is a string constant |
| Adversary | Attack surface, exploitation paths | 1.5 | Script-kiddie auth bypass; admin self-registration; BullMQ injection |
| Chart Keeper | FHIR R4, ICD-10, clinical data modeling | 2.0 | FHIR gateway non-functional; all timestamps as text; PHI to LLM |
| Oversight | LLM safety, prompt injection, response validation | 2.5 | Prompt injection via notes; silent parse failures; bad dedup logic |
| HIPAA Expert | 45 CFR Part 164 compliance | 1.5 | 3 Required safeguard gaps block any production deployment |

**Aggregate (core 1.0x, extended 0.8x):**
Core (Skeptic + Guardian + Builder + Minimalist): (2.0 + 1.5 + 2.5 + 2.5) / 4 = 2.125
Extended (Adversary + Chart Keeper + Oversight + HIPAA Expert): (1.5 + 2.0 + 2.5 + 1.5) / 4 × 0.8 = 1.55
**Final: ~2.0 / 5**

---

## Consensus Findings (6+ agents agree)

### C1: Authentication is not functioning as a security control
All 8 agents flagged the `x-dev-user-id` header bypass (`auth.ts:41`) and/or the `"hashed:" + password` storage (`auth/router.ts:39-47`). The platform has no functioning authentication boundary: a single HTTP header grants full admin access in any non-production-labeled environment. Passwords are stored with a reversible string prefix.

### C2: No authorization enforcement on any clinical data endpoint
7 agents noted that all service routers use `initTRPC.create()` (no user context) and `t.procedure` (no auth gate). A patient-role session can prescribe medications. An unauthenticated caller can list all patients. The `ROLE_PERMISSIONS` matrix in `shared-types/src/auth.ts:38-73` is entirely decorative.

### C3: PHI is transmitted to Anthropic Claude API without de-identification or confirmed BAA
6 agents flagged `context-builder.ts:30-203` + `claude-client.ts:44-55`. Full patient records — diagnoses, medications, vitals, labs, care team names — are serialized and sent to an external API with no redaction, no de-identification, and no code-level verification of a BAA. This is a HIPAA §164.308(b)(1) violation on first production use.

### C4: The API gateway routes nothing clinical
6 agents confirmed `services/api-gateway/src/router.ts:18` — `mergeRouters(healthRouter)`. All service routers exist but are orphaned. The platform cannot route any clinical request end-to-end. The frontend uses `type AppRouter = any`.

### C5: ClinicalEvent type is defined 3 ways; AI oversight worker receives the wrong shape
5 agents identified the split between `clinical-data/src/events.ts` (`patientId`, `resourceId`, `payload`), `clinical-notes/src/events.ts`, and `packages/shared-types/src/ai-flags.ts` (`patient_id`, `id`, `data`). The worker casts `job.data as ClinicalEvent` using the shared-types version but receives the incompatible local shape. `event.patient_id` is `undefined` for every event processed — the DVT detection rule cannot fire.

---

## Contested Points

| Topic | Agent A | Agent B |
|---|---|---|
| Service decomposition | **Minimalist** (2/5): 9 fake services, pure overhead, should collapse | **Guardian** (3/5): separation useful for future isolation, current risk is auth not structure |
| shared-types/validators split | **Minimalist**: merge into one package with `z.infer<>` | **Builder**: manageable overhead, low-priority given blockers |
| FHIR investment | **Chart Keeper**: FHIR gateway non-functional, blocking interoperability goal | **Minimalist**: YAGNI — don't invest until a real FHIR use case exists |

---

## Factual Corrections

| Claim | Reality |
|---|---|
| "AI oversight reviews every clinical event" | Worker is never started (`index.ts` exports but doesn't call `startReviewWorker()`); event type mismatch makes all processing fail |
| "FHIR R4 interoperability layer" | `exportPatient` always returns `entry: []`; imports never link to patients (`patient_id: null`) |
| "Role-based access controls" | No role check exists on any clinical endpoint; `ROLE_PERMISSIONS` is a type definition, not enforcement |
| "Audit logging for all PHI access" | `resource_id = ""` for all tRPC; `details` never populated; patient ID not captured |
| "Secure session management" | Sessions: raw UUIDs, no IP binding, no activity timeout, no HttpOnly/Secure cookie flags |

---

## Risk Heatmap

```
IMPACT
  5 |         [C1-Auth] [C2-RBAC]
    |    [C5-EventType] [C3-BAA/PHI]
  4 |  [C4-Gateway] [Injection] [AdminReg]
    |         [Redis] [ParseFail] [Dedup]
  3 |   [NoMigrations] [NoWorker] [CORS]
    |      [N+1] [Timestamps] [FHIR]
  2 |    [Fake Services] [fhir-utils] [NoTests]
    |
  1 |___________________________________
       1    2    3    4    5
             LIKELIHOOD
```

---

## Recommended Action Plan

### P0 — Block Deployment (before any PHI touches the system)

1. **Execute BAA with Anthropic** — Contractual, hours. Prerequisite for all LLM use.
2. **Real password hashing** — Add `argon2` to auth package, replace `"hashed:"` prefix. Low effort, Required HIPAA safeguard.
3. **Remove `x-dev-user-id` bypass** — Replace with standard seeded test accounts. Low effort, Required HIPAA safeguard.
4. **Fix ClinicalEvent type split** — Delete local event type definitions, import from `@carebridge/shared-types`. Unblocks the entire AI oversight pipeline.
5. **PHI de-identification before LLM** — Strip/pseudonymize care team names; use internal patient ID only. Minimum-necessary for BAA compliance.
6. **LLM output Zod validation** — Replace loose type predicate with strict schema. Prevents corrupt data entering clinical record.

### P1 — Pre-Launch (before any clinical users)

7. **Wire API gateway** — Import and merge all service routers into `appRouter`. Unblocks end-to-end functionality.
8. **Add auth context to all service routers** — Apply `protectedProcedure` to every clinical endpoint.
9. **Generate and commit Drizzle migrations** — Run `pnpm db:generate`, commit output. Unblocks all developer onboarding.
10. **Create ai-oversight server entrypoint** — `server.ts` that calls `startReviewWorker()`. Worker currently never starts.
11. **Redis requirepass + internal network** — Remove public port binding, add authentication.
12. **Session inactivity timeout** — Add `last_active_at` to sessions, enforce 15-min idle logoff.
13. **Prompt injection hardening** — Add anti-injection directive to system prompt; wrap free-text fields in data tags.
14. **Fix deduplication logic** — Remove `category + severity` fallback; check against persisted flags.

### P2 — 30 Days Post-Launch

15. **Enrich audit log** — Capture `patient_id`, `details` JSON, populate `resource_id` from tRPC procedure arguments.
16. **Fix cross-specialty rules for non-symptom events** — Re-evaluate full risk profile on new data, not just symptom extraction.
17. **Parse failure observability** — Log raw LLM response on failure, record `status: "completed_rules_only"`.
18. **Fix N+1 queries** — `inArray` batch for lab results and care team names in context builder.
19. **Implement emergency access (break-glass)** — Separate audit trail, time-limited, justification required.

### P3 — 90 Days

20. **Column encryption for PHI at rest** — `pgcrypto` for DOB, MRN, insurance_id, emergency contacts.
21. **Migrate timestamps to `timestamptz`** — Schema migration for all `_at` columns.
22. **ICD-10 codes as `jsonb`** — `procedures.icd10_codes` schema change.
23. **Write tests** — Unit tests for all deterministic rules; integration test for DVT scenario end-to-end.
24. **MFA for clinician accounts** — TOTP/WebAuthn for physician/admin roles.

---

## Final Verdict

CareBridge has a technically interesting architecture — the AI oversight concept (deterministic rules → LLM review → flag generation) is clinically sound and the rule logic shows genuine domain knowledge. The Drizzle schema is well-normalized. The BullMQ + tRPC + Fastify stack is a sensible choice.

But the platform is not a functional system today. It is a structural scaffold with critical gaps at every integration point: the gateway routes nothing, the event types are mismatched, the worker never starts, the frontend shows hardcoded data, and there are no database migrations. More seriously, every security and compliance control is either absent or implemented as a placeholder — passwords use a string prefix, RBAC is a type definition, auth is a single header away from full bypass, and full patient PHI flows to an external API with no de-identification.

The path from current state to production-ready healthcare platform requires focused remediation across authentication, authorization, HIPAA compliance, and core functionality — roughly in that order. The foundational code quality is good enough to build on. It needs to be hardened, not rewritten.

**Recommendation: Revise before any PHI exposure. The P0 items are days of engineering work; the regulatory exposure from skipping them is measured in millions of dollars of potential penalties.**

---

## Appendix — Individual Reports

| # | Agent | File | Rating |
|---|---|---|---|
| 1 | Skeptic | [01-skeptic.md](01-skeptic.md) | 2.0/5 |
| 2 | Guardian | [02-guardian.md](02-guardian.md) | 1.5/5 |
| 3 | Builder | [03-builder.md](03-builder.md) | 2.5/5 |
| 4 | Minimalist | [04-minimalist.md](04-minimalist.md) | 2.5/5 |
| 5 | Adversary | [05-adversary.md](05-adversary.md) | 1.5/5 |
| 6 | Chart Keeper | [06-chart-keeper.md](06-chart-keeper.md) | 2.0/5 |
| 7 | Oversight | [07-oversight.md](07-oversight.md) | 2.5/5 |
| 8 | HIPAA Expert | [08-hipaa-expert.md](08-hipaa-expert.md) | 1.5/5 |
