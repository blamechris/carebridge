# @carebridge/fhir-gateway

FHIR R4 / US Core mappers and generators that translate CareBridge's
internal clinical model to FHIR resources for the patient portal,
outbound API consumers, and the Epic connector.

## Layout

- `src/*-mapper.ts` — Per-resource mappers (Patient, Condition, Allergy,
  Observation, Medication, DiagnosticReport).
- `src/generators/` — Helpers that produce FHIR primitives (e.g.
  `ucum.ts` for `Quantity.code` validation).
- `src/schemas/`, `src/types/` — Zod schemas and TypeScript types for
  outbound payloads.
- `src/router.ts` — tRPC router exposing the gateway to internal
  services.

## Third-party licenses

This service bundles or links against third-party packages with custom
or non-MIT licenses. See [`NOTICES.md`](./NOTICES.md) for full
attribution.

In particular, [`@lhncbc/ucum-lhc`](https://github.com/lhncbc/ucum-lhc)
is distributed under a BSD-derived license from the U.S. National Library
of Medicine's Lister Hill National Center for Biomedical Communications
(LHNCBC), with sub-licenses for UCUM table content (Regenstrief Institute
+ UCUM Organization) and, where applicable, LOINC content. Any
redistribution of CareBridge that includes this service must reproduce
the notices in `NOTICES.md`.
