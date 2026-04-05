# Minimalist's Audit: CareBridge Full Platform

**Agent**: Minimalist — Ruthless engineer who believes the best code is no code
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-05

## Section Ratings

### 1. Monorepo Structure — 2/5
- Turborepo justified only for independently deployable artifacts
- All "services" share the same DB, same process — this is a monolith in microservices clothing
- 9 `package.json`, 9 `tsconfig.json`, 9 build steps for zero operational benefit

### 2. Service Decomposition — 1/5
- `services/scheduling`: full package setup, returns `[]` with `// stub` comments
- `services/fhir-gateway`: placeholder function, stub export
- These are directory-level TODOs masquerading as services

### 3. Shared Packages — 2/5
- `packages/fhir-utils` exports: `FHIR_VERSION = "R4"` — a string constant in its own compiled package
- `shared-types` and `validators` are mirrored file-for-file — two packages, one should exist
- Zod's `z.infer<>` can consolidate both into one package

### 4. Auth Service — 3/5
- Genuinely implemented, provides value
- Two separate `initTRPC` instances with duplicate `isAuthenticated` middleware
- `protectedProcedure` in api-gateway typed as `any`

### 5. AI Oversight — 4/5
- Core value proposition, appropriately complex
- N+1 queries in context builder for lab results and care team

### 6. API Gateway — 3/5
- Correct skeleton, wrong body
- Routes nothing but the health check today

## Top 5 Findings

1. **9 "services" are modules, not services** — share DB, share process, no network boundary — pure overhead
2. **`packages/fhir-utils` is a string constant** — `FHIR_VERSION = "R4"` doesn't justify its own compiled package
3. **`shared-types` + `validators` should be one package** — mirrored files, dual maintenance, consumers import from two places
4. **`protectedProcedure: any`** — `api-gateway/src/trpc.ts:26` — type hole at the core security primitive
5. **N+1 queries in hot path** — `context-builder.ts:140-148,160-169` — sequential queries per panel ID and per care team member

## Recommendations

| Priority | Action | Effort |
|---|---|---|
| P1 | Collapse 6 app services into `services/api` with sub-routers | Medium |
| P1 | Wire service routers into gateway | Low |
| P1 | Fix `protectedProcedure: any` | Low |
| P2 | Merge `shared-types` into `validators` | Medium |
| P2 | Delete `packages/fhir-utils`, delete `services/scheduling` stub | Low |
| P3 | Fix N+1 with `inArray` batch queries | Low |

## Overall Rating: 2.5/5

The AI oversight engine — the real differentiator — is well-implemented and justified. Everything around it is inflated. Nine fake microservices, six packages (one exports a string constant), a Turborepo build graph for a monolith. The 80/20 cut: merge services, delete empty packages, fix the type hole in the security primitive.
