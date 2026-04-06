# Minimalist's Audit: CareBridge Full Codebase

**Agent**: Minimalist — ruthless engineer; YAGNI, complexity reduction, what to cut
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Package structure | 3/5 | `fhir-utils` is a stub, `redis-config` is a one-liner |
| Service count | 2/5 | `scheduling` and `fhir-gateway` are dead code in the build |
| Auth complexity | 2/5 | Homegrown JWT+TOTP adds 273 lines of risky custom crypto |
| Code duplication | 2/5 | Three incompatible ClinicalEvent types; User-mapping repeated 3x |
| Context builder | 3/5 | N+1 queries in two loops |
| phi-sanitizer | 1/5 | Complete, tested, wired to nothing |
| YAGNI violations | 2/5 | Token budget, MedLens OAuth, key rotation — all premature |

---

## Top 5 Findings

### Finding 1 — Three Incompatible `ClinicalEvent` Definitions on the Same Queue (Critical)

- `/services/clinical-data/src/events.ts:4` — `{ type, resourceId, patientId, payload }`
- `/services/clinical-notes/src/events.ts:4` — `{ type, noteId, patientId, providerId, payload }`
- `/packages/shared-types/src/ai-flags.ts:93` — `{ id, type, patient_id, data }`

The shared-types version is what the consumer uses. The two producers don't. The AI oversight engine silently receives malformed events. This is a runtime bug disguised as a code quality issue.

**Fix:** Delete the two local `ClinicalEvent` definitions. Import from `@carebridge/shared-types`. 10-line change.

---

### Finding 2 — `phi-sanitizer` Package is Complete, Tested, Wired to Nothing

`/packages/phi-sanitizer/src/redactor.ts` (197 lines) and `/packages/phi-sanitizer/src/llm-validator.ts` (186 lines) — built, tested, not in `ai-oversight`'s `package.json`. PHI flows unredacted to external Claude API. LLM output is not validated before becoming a clinical flag.

**Fix:** Either wire into `review-service.ts` (5-line change) or delete the package and document it as future work.

---

### Finding 3 — `fhir-utils` Package and `scheduling` Service Are Dead Build Weight

`/packages/fhir-utils/src/index.ts` — one stub function, 5 TODO comments, 0 real code. Not imported by anything.

`/services/scheduling/src/router.ts` — 21 lines, both procedures return `[]`. Own package, `tsconfig.json`, build pipeline.

Both add turbo build steps for zero functionality.

**Fix:** Delete both. Re-add when there's implementation.

---

### Finding 4 — Homegrown JWT (101 lines) + TOTP (172 lines) Instead of Vetted Libraries

`/services/auth/src/jwt.ts` — hand-rolled HS256 with base64url encode/decode from scratch.
`/services/auth/src/totp.ts` — hand-rolled RFC 6238 with Base32 codec from scratch.

273 lines of custom security-critical code where `jose` + `otpauth` would be ~5 import lines. Custom crypto implementations are liability code.

**Fix:** Replace `jwt.ts` with `jose`. Replace `totp.ts` with `otpauth`. Delete ~273 lines.

---

### Finding 5 — N+1 Queries in Context Builder Hot Path

`/services/ai-oversight/src/workers/context-builder.ts:139-155` — sequential loop fetching lab results per panel ID instead of one `inArray()` query.

`/services/ai-oversight/src/workers/context-builder.ts:160-169` — sequential loop fetching care team user names per member ID instead of one `inArray()` query.

Both run on every clinical event. Two loops → two `inArray` queries = trivial fix.

---

## Concrete Cuts (Priority Order)

1. Delete `/packages/fhir-utils/` — 0 consumers, 0 real code
2. Delete `/services/scheduling/` — pure stub
3. Fix `ClinicalEvent` type mismatch — it's a runtime bug
4. Wire `phi-sanitizer` or delete it
5. Replace `jwt.ts` + `totp.ts` with `jose` + `otpauth` (~273 lines → ~5 lines)
6. Move MFA rate limit + pending sessions to Redis (or DB)
7. Remove BullMQ cleanup worker; use `setInterval` or `pg_cron`
8. Fix N+1 queries in `context-builder.ts`
9. Remove `packages/redis-config`; inline into `db-schema` or a shared util
10. Env-var the `localhost:4000` URL in `portal-shared/src/trpc.ts`
11. Delete `medlens-bridge.ts` token system — build when MedLens exists
12. Defer token budget truncation — premature optimization

---

## Overall Rating: 2.5/5

CareBridge carries 4–5 services of scaffolding for features that don't exist yet (FHIR, scheduling, MedLens, token budget, key rotation at scale) while shipping a silent runtime bug in the most critical data path. The phi-sanitizer was built, tested, and not connected. Custom JWT/TOTP are liability code. The overall pattern: too much infrastructure, too little integration.
