# Launch Checklist — Clinical Attestation

CareBridge is pre-launch. Engineering merges of `clinical-safety` PRs are
gated only on engineering review + primary-source citations (see
[`docs/ai-prompt-editing.md`](docs/ai-prompt-editing.md) § 5). Live patient
use is gated on a credentialed clinician (physician, PharmD, or clinical
informaticist) walking through every merged clinical-safety change and
recording an attestation here.

This file is the production-launch gate, not the merge gate. Do not enable
patient-facing access in production until every item below is checked.

## Format

Each entry is keyed by the merge commit SHA and PR number. The entry MUST
include the primary source(s) cited at merge so the reviewer doesn't have
to reconstruct them.

```
### PR #<n> — <short title> (<merge SHA>)

**Subsystem:** <e.g. clinical rules / LLM prompt / vital validators>
**Citations:** <FDA PI section, WHO MGRS, CDC growth charts, etc.>
**What needs attestation:** <one sentence on the clinical claim being made>

- [ ] Clinician reviewed citations and concurs with class membership / band
      edges / severity mapping
- [ ] Signed by: __________________  Date: __________
```

## Pending Attestations

<!-- Newest first. Add at the top when you merge a clinical-safety PR. -->

### PR #1242 — age-stratified anthropometric bounds + age-aware validateVital (merge SHA pending)

**Subsystem:** Clinical validators — `packages/medical-logic/src/medical-validation.ts`

**Citations:**

- WHO Child Growth Standards (MGRS), head_circumference + body_height, 0–60 months. https://www.who.int/tools/child-growth-standards
- CDC growth charts, body_height + BMI, 2–20 years. https://www.cdc.gov/growthcharts/clinical_charts.htm
- AAP Bright Futures / CDC pediatric OFC guidance, WHO→CDC handoff at 24 months.

**What needs attestation:** Numeric band edges in `PEDIATRIC_VITAL_RANGES` (neonate / infant / child / school_age / adolescent) for `body_height`, `head_circumference`, and `bmi`, plus the adult `body_height.criticalLow = 140 cm` and `bmi.criticalLow = 12 / warningLow = 16` additions to `VITAL_DANGER_ZONES`.

- [ ] Clinician (pref. peds) reviews the band table head-to-toe and concurs with critical / plausibility thresholds
- [ ] Specifically reviews OFC bands per #1175 AC ("Nurse sign-off on age-stratified thresholds, especially OFC bands")
- [ ] Signed by: __________________  Date: __________

## Completed Attestations

<!-- Move entries here after sign-off. Keep them for the audit trail. -->
