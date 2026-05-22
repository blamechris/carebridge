# FHIR interoperability — CareBridge identifier namespace

This document describes the canonical URL namespace under which
CareBridge mints FHIR R4 `Identifier.system` values, and how new
identifier types should be added.

It also lists the legacy namespace that was emitted prior to PR #1014
so a future EHR integration importing historical FHIR bundles knows
both shapes can appear.

## Canonical namespace

```
CAREBRIDGE_IDENTIFIER_BASE = "https://carebridge.dev/fhir/sid"
```

Defined in `services/fhir-gateway/src/generators/identifiers.ts` and
re-exported from `services/fhir-gateway/src/generators/index.ts`. All
CareBridge-minted FHIR resource identifiers use this URL as the
`Identifier.system` prefix.

### Why a URL-form `system`?

Epic, Cerner, and other major EHRs are trained to recognise URL-form
`system` values. An ad-hoc `urn:` scheme (e.g. `urn:carebridge:patient`)
parses correctly per the FHIR spec but is hostile to the matching
heuristics most consumers actually run. The path segment also lets us
distinguish identifier *types* (MRN, user-id, etc.) under the same
authority without minting a new system for each.

### Convention for new identifiers

Add a path segment under the base named for the domain object:

```
${CAREBRIDGE_IDENTIFIER_BASE}/<resource>-id
```

Examples currently in use:

| Resource     | `system` URL                                          | Generator                          |
|--------------|-------------------------------------------------------|------------------------------------|
| Practitioner | `https://carebridge.dev/fhir/sid/user-id`             | `generators/practitioner.ts`       |
| Patient (MRN)| `https://carebridge.dev/fhir/sid/mrn`                 | `generators/patient.ts`            |

When adding a new resource generator, do not invent a new domain or
scheme — extend the path under the canonical base. This keeps the
authority single and makes external indexing predictable.

## Legacy namespace — Patient MRN prior to PR #1014

Before PR #1014, the Patient `Identifier.system` for MRN was emitted
as:

```
http://carebridge.health/mrn
```

This was a different domain (`carebridge.health` vs `carebridge.dev`),
a different scheme (`http` vs `https`), and a different path shape
(no `/fhir/sid` infix). PR #1014 migrated it to the canonical
namespace.

There were no external consumers keying on the old URL at migration
time, so no migration shim was included. However, **any future EHR
integration that ingests historical FHIR bundles produced before PR
#1014 may see the legacy URL**. Consumers ingesting CareBridge MRNs
should treat both:

- `http://carebridge.health/mrn`  *(legacy, ≤ PR #1014)*
- `https://carebridge.dev/fhir/sid/mrn`  *(canonical, current)*

as equivalent for the purpose of patient identity reconciliation.

## References

- PR [#958](https://github.com/blamechris/carebridge/pull/958) — introduced `CAREBRIDGE_IDENTIFIER_BASE` for Practitioner
- PR [#1014](https://github.com/blamechris/carebridge/pull/1014) — migrated Patient MRN onto the canonical base
- PR [#969](https://github.com/blamechris/carebridge/pull/969) — hoisted the constant out of `practitioner.ts` into its own module
- Issue [#1037](https://github.com/blamechris/carebridge/issues/1037) — this doc
