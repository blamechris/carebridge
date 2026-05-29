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

<!-- Entries seeded with the inaugural pre-launch merges go here. -->

## Completed Attestations

<!-- Move entries here after sign-off. Keep them for the audit trail. -->
