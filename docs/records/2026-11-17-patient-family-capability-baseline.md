---
type: investigation
date: 2026-11-17
scope: patient-family-capability-baseline
evidence: static-source-inspection
source_commit: 84e3a804c6d10f79ccde4448e5c86e71815b103b
---

# Patient/family capability baseline

On 2026-11-17, static source inspection at main commit
`84e3a804c6d10f79ccde4448e5c86e71815b103b` found the components below.
Code existence is evidence of implementation structure, not runtime readiness,
clinical validation, or proof of a complete patient/family workflow.

The patient/family-first direction and fictional discussion examples are proposed
in [companion PR #1341](https://github.com/blamechris/carebridge/pull/1341).
That proposal starts with information people can access, understanding it, and
preparing questions for their care team. This inventory does not establish that
experience or select its first clinical use case or rule.

## Unranked source evidence and proof limits

| Component and inspected source | Source fact | What this does not prove |
|---|---|---|
| [Patient health-summary page](../../apps/patient-portal/app/health-summary/page.tsx) | Uses `useMyPatientRecord`; wires diagnosis, allergy, and care-team queries to the linked record and renders those sections with loading/error states. | Correct, complete, or understandable information in a running session; ingestion of information a person brings; source-grounded explanations or prepared questions. UI inspection is not an API authorization guarantee. |
| [Clinician inbox](../../apps/clinician-portal/app/inbox/page.tsx) | Queries open flags; presents acknowledge, resolve, and dismiss actions through `FlagActionModal`; passes `resolution_note` or `dismiss_reason` to the corresponding mutation. | Successful state changes, appropriate review, or a patient/family review experience. These call sites do not establish server-side enforcement. |
| [Flag schema](../../packages/db-schema/src/schema/ai-flags.ts) and [flag service](../../services/ai-oversight/src/services/flag-service.ts) | Schema declares a non-null `requires_human_review` field with default `true` and review/lifecycle fields. `createFlag` uses an explicit supplied review value, otherwise defaults according to whether the source is `ai-review`; resolve/dismiss functions write the note/reason and actor/time fields. | That every flag always requires review, that a clinician actually reviewed an output, or that these fields alone enforce all review/deployment requirements. |
| [Historical deterioration detectors](../../packages/medical-logic/src/deterioration-patterns.ts) | Contains function bodies for `detectReadmissionTrajectory`, `detectDischargeReadinessRisk`, and `detectCrossSpecialtySymptomOrphan`, returning structured `PatternResult` values. Its header labels the original heuristics as a scaffolding milestone with clinician calibration pending. | Validated clinical performance, patient-ready interpretation, or selection of any detector as the first patient-product rule. Historical ordering does not prioritize the new direction. |
| [Bridge pair route](../../apps/clinician-bridge/app/api/v1/pair/route.ts) | Parses the request schema, generates a pairing response, builds a ciphertext envelope, calls `relayStore.put`, and returns a response. | A deployed relay, successful persistence/retrieval in its deployment, a working MedLens client, or authorized end-to-end sharing. The called store and other routes were not inspected here. |
| [Bridge session view](../../apps/clinician-bridge/app/session/[code]/SessionView.tsx) | Renders supplied envelope metadata and a banner. Its comment and milestone text describe this as an M2 placeholder and put decryption/rule-output rendering in M3. | Successful decryption, rule execution, or a deployed end-to-end MedLens handoff. The view's own round-trip wording is not runtime evidence from this inspection. |

These are bounded observations of the linked files, not an exhaustive feature or
authorization inventory. A UI fact cannot establish universal patient exclusion
from flags across API paths. No such guarantee is made here, and no broad search
is used to claim a feature is absent everywhere.

## Four distinct evidence states

- **Code existence:** the linked source facts above were inspected at the stated
  commit. Imported dependencies and downstream services were not traced beyond
  those files.
- **Past CI evidence:** no CI run or result was inspected or executed for this
  baseline. Any separately cited green run needs its own commit, check names,
  and scope; green checks alone do not prove the intended family workflow.
- **Runtime readiness:** untested here. No application, service, relay, database,
  provider, device, or deployment was exercised. Static inspection does not
  demonstrate that these components work together in a user session.
- **Intended capability:** accessible-information understanding, source-grounded
  questions, and the broader patient/family experience remain product intent in
  the companion proposal; this inventory supplies no validation of that intent.

## Evidence still needed

These are evidence gaps, not authorization to collect data, run integrations,
share information, deploy, or choose a clinical use case. No ordering is implied.

- Defined workflow boundaries and observable acceptance criteria for any future
  patient/family capability, including how sources, unknowns, and questions would
  be represented.
- A reproducible synthetic walkthrough tying a specific commit to the relevant
  UI, API, source references, and resulting user-visible behavior.
- Any applicable CI run evidence, labeled by commit and actual coverage, plus
  separate runtime evidence for the workflow that CI does not exercise.
- For a proposed bridge workflow, evidence covering the participating client,
  relay, retrieval, decryption, and rendering together in the intended environment.
- Appropriate privacy/access authority, review requirements, and patient-facing
  evaluation for the eventual behavior before real information or deployment.

The [README research warning](../../README.md) and
[patient-facing deployment gates](../../LAUNCH-CHECKLIST.md) remain applicable.
This record changes no runtime behavior or authority and draws no clinical
efficacy, validated-outcome, or future legal/device-classification conclusion.
