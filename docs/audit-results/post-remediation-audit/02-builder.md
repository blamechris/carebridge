# Builder's Audit: CareBridge Post-Remediation

**Agent**: Builder — Pragmatic full-stack dev; implementability and wiring
**Overall Rating**: 3.3 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Service Wiring | 4/5 | All routers mounted; FHIR export still stub on main |
| Package Exports | 4/5 | Clean exports; minor vitest duplication |
| Build Pipeline | 4/5 | 17/17 turbo tasks pass |
| Dev Experience | 3/5 | ai-oversight dev script added; integrated startup unclear |
| E2E Data Flow | 3/5 | Patient->Notes->Flags works; FHIR export stub |
| FHIR Pipeline | 2/5 | Generators built but exportPatient returns empty Bundle on main |
| Test Infrastructure | 3/5 | ~200 tests; vitest configs have duplicates |

---

## Top 5 Findings

### Finding 1 — FHIR Export Still Returns Empty Bundle on Main
**File:** `services/fhir-gateway/src/router.ts:48-52`
exportPatient is a stub returning `{ entry: [] }`. Implementation exists in commit ef9f083 but may not be on main.

### Finding 2 — MedLens Bridge Stubs Don't Persist Data
**File:** `services/fhir-gateway/src/medlens-bridge.ts:132,162,196`
importVitals and importLabs accept data but never write to the database.

### Finding 3 — AI Oversight Flag Queries Unprotected
**File:** `services/ai-oversight/src/router.ts:46-55`
flags.getByPatient and reviews.getByPatient have no authentication middleware.

### Finding 4 — Duplicate vitest.config.ts Resolve Blocks
**Files:** `services/auth/vitest.config.ts`, `services/fhir-gateway/vitest.config.ts`
Duplicate `resolve` keys — second silently overwrites first.

### Finding 5 — FHIR Generators Handle Nulls But Never Tested E2E
**File:** `services/fhir-gateway/src/generators/`
Edge cases for encrypted fields, null LOINC codes untested in integration.
