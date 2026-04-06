# Minimalist's Audit: CareBridge Post-Remediation

**Agent**: Minimalist — Ruthless engineer; YAGNI, complexity reduction
**Overall Rating**: 2.2 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Package Structure | 2/5 | fhir-utils still exists (empty); validators duplicates shared-types |
| Code Duplication | 1/5 | 6 duplicate FHIR type interfaces across generators |
| Dead Code | 2/5 | Empty fhir-utils; unused clearCareTeamCache export |
| Abstraction Level | 2/5 | Repository layer over-abstraction; per-service tRPC context duplication |
| Test Quality | 3/5 | Good coverage; heavy mocking makes tests brittle |
| Config Management | 2/5 | 9 vitest configs; duplicate resolve blocks; inconsistent globals |

---

## Top 5 Things to Cut

### 1. Delete `/packages/fhir-utils/` — 0 source files, 0 consumers

### 2. Consolidate FHIR Type Definitions
6 duplicate FhirCoding interfaces across generators. Move to `types/fhir-r4.ts`.
- `generators/observation.ts:7` defines `Coding`
- `generators/medication-statement.ts:14` defines `FhirCoding`
- `generators/condition.ts:14` defines `FhirCoding`
- `generators/allergy-intolerance.ts:13` defines `FhirCoding`

### 3. Merge `validators` into `shared-types`
Both define MedRoute, MedStatus, VitalType. Zod schemas belong alongside interfaces.

### 4. Centralize vitest Configuration
9 separate vitest.config.ts with manual alias paths. One has duplicate resolve block.

### 5. Collapse Repository Layer
4 repo files in clinical-data follow identical CRUD patterns. Inline into router.
