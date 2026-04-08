# CDS Non-Device Exemption Memo

## Purpose

Document why the CareBridge `ai-oversight` clinical flag system qualifies as
**non-device Clinical Decision Support (CDS)** under §520(o)(1)(E) of the
FD&C Act (21st Century Cures Act §3060) and FDA's Clinical Decision Support
Software guidance.

## The Four Statutory Criteria

The software is non-device CDS only if it meets **all four**:

1. **Not intended to acquire, process, or analyze a medical image, signal,
   or pattern from an in vitro diagnostic device.**
   - CareBridge ingests structured EHR data (diagnoses, medications, vitals,
     symptoms, lab numerics). It does not process images or raw IVD signals.
   - ✅ Met.

2. **Intended to display, analyze, or print medical information about a patient.**
   - The system surfaces flags to clinicians via the clinician portal.
   - ✅ Met.

3. **Intended to support or provide recommendations to a HCP about prevention,
   diagnosis, or treatment.**
   - Flags include `summary`, `rationale`, and `suggested_action` fields.
   - ✅ Met.

4. **Intended to enable the HCP to independently review the basis for the
   recommendation so they do not rely primarily on the recommendation.**
   - **This is the criterion that requires active maintenance.**

## How CareBridge Satisfies Independent Review

| Control | File / Mechanism |
|---|---|
| Every flag carries a human-readable `rationale` | `packages/db-schema/src/schema/ai-flags.ts` |
| Deterministic rule flags include a stable `rule_id` traceable to source code | `services/ai-oversight/src/rules/cross-specialty.ts` |
| LLM flags record `model_id` and `prompt_version` for reproducibility | `clinical_flags.model_id`, `clinical_flags.prompt_version` |
| LLM flags are gated by `requires_human_review = true` | `services/ai-oversight/src/services/flag-service.ts` |
| Redacted prompt persisted for forensics | `review_jobs.redacted_prompt` |
| Clinician must enter a reason to dismiss/resolve | `apps/clinician-portal/src/components/flag-action-modal.tsx` |
| Patient portal does NOT surface AI flags | `apps/patient-portal/` (no flag UI) |

## Non-Exempt Boundaries

The following would push CareBridge into **device** classification and are
explicitly out of scope:

- Auto-acting on a flag (e.g., auto-discontinuing a medication).
- Surfacing AI-generated diagnostic conclusions to patients.
- Time-critical decisions where independent review is impractical
  (e.g., closed-loop alerts in the OR).
- Marketing language claiming "diagnoses missed conditions" or
  "predicts patient outcomes."

## Approved Marketing Language

- ✅ "Surfaces cross-chart inconsistencies for clinician review."
- ✅ "First-pass safety net flagging known dangerous patterns."
- ❌ "AI catches missed diagnoses."
- ❌ "Predictive clinical intelligence."
- ❌ "Replaces second-opinion consultation."

## Review Cadence

This memo is reviewed quarterly by the compliance team and any time:
- A new flag category is added
- The LLM model is upgraded
- Any flag is configured to bypass `requires_human_review`
- Marketing or UI copy changes
