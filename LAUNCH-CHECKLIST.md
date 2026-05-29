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

### PR #1243 — glycopeptide drug-class cross-reactivity anchor (merge SHA pending)

**Subsystem:** LLM prompt anchors + deterministic cross-reactivity rule

- `packages/ai-prompts/src/drug-class-anchors.ts` (`DRUG_CLASS_CROSS_REACTIONS`)
- `packages/medical-logic/src/cross-reactivity-map.ts` (`CROSS_REACTIVITY_MAP`)
- Bumps `PROMPT_VERSION` 1.2.0 → 1.3.0

**Citations:** FDA Prescribing Information for DALVANCE (dalbavancin), revision 11 (2021), § 5.2 Hypersensitivity Reactions. https://www.accessdata.fda.gov/drugsatfda_docs/label/2021/021883s011lbl.pdf

> "Serious hypersensitivity (anaphylactic) and skin reactions have been reported with glycopeptide antibacterial agents, including DALVANCE. ... If an allergic reaction to DALVANCE occurs, discontinue DALVANCE."

**What needs attestation:** Class membership (vancomycin, teicoplanin, dalbavancin, oritavancin, telavancin treated as a single cross-reactive glycopeptide class, including the lipoglycopeptide subclass) and the severity / `medication-safety` category mapping.

- [ ] PharmD or clinical informaticist confirms class membership per FDA labeling + other primary references (Lexicomp / Micromedex)
- [ ] Confirms severity / flag category appropriate
- [ ] Reviews `PROMPT_VERSION` 1.2.0 → 1.3.0 bump scope
- [ ] Signed by: __________________  Date: __________

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
