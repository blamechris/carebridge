# FHIR Code System Licensing

This document tracks third-party code-system licenses that gate what
CareBridge is allowed to distribute in outbound FHIR bundles. The
practical concern is that several widely used FHIR code systems
(CPT, SNOMED CT, LOINC under some conditions) are licensed by their
publishers, and including those codings in a FHIR resource sent to
an external recipient may constitute redistribution.

Each gated system has a corresponding environment flag and a default
that fails safe (no emission until the license question is resolved).

## CPT (AMA Current Procedural Terminology)

### Status

**Default: emission disabled.** `FHIR_CPT_EMISSION_ENABLED` defaults
to anything other than the literal string `"true"`, which means the
fhir-gateway omits CPT codings from `Procedure.code`.

### Context

`services/fhir-gateway/src/generators/procedure.ts` historically
emitted CPT codings on `Procedure.code` using the AMA CPT system URL
(`http://www.ama-assn.org/go/cpt`). This is FHIR-correct: the AMA is
the canonical source for CPT and that system URL is the registered
identifier.

The American Medical Association licenses CPT code usage. Distributing
CPT codes in a FHIR bundle to an external recipient may require an
AMA CPT license agreement (end-user agreement, organisational
license, or similar). The required license depends on the deployment
model and the number / nature of recipients.

CareBridge has not yet confirmed which license tier covers its
intended FHIR export path. Until that is confirmed, emission is
gated off by default.

### The gate

`services/fhir-gateway/src/generators/procedure.ts` reads
`process.env.FHIR_CPT_EMISSION_ENABLED` at call time. CPT codings
are only emitted when the value is exactly the string `"true"`. Any
other value (unset, `"false"`, `"1"`, `"yes"`, etc.) keeps the gate
closed.

When the gate is closed, `Procedure.code` still emits a useful
free-text fallback via the existing `code.text = procedure.name`
path. Downstream consumers see a Procedure with a human-readable
description but no licensed coding.

### What needs to happen before flipping the gate

1. **Confirm with CareBridge legal / compliance** whether the
   intended FHIR export model (which recipients, what volume, what
   commercial relationship) requires an AMA CPT license.
2. **If a license is required:** obtain the appropriate AMA license
   covering distribution. Record the license reference in this
   document.
3. **If no license is required** (e.g. recipient is a covered entity
   with their own CPT license, or the export is intra-organisational
   only): document the basis in this file with the date and the
   stakeholder who confirmed.
4. **Flip the flag in the relevant deployment environments:**
   ```
   FHIR_CPT_EMISSION_ENABLED=true
   ```

### Tests

- `services/fhir-gateway/src/__tests__/procedure.test.ts` covers
  both the gated-off path (default) and the gated-on path. The
  gated-off path asserts that `Procedure.code.coding` is undefined
  even when the source row has a `cpt_code` value, and that the
  free-text fallback is still populated.

### Related

- Issue #939 — tracking issue for the AMA CPT licensing question.
- PR #922 — the change that first introduced CPT emission.
