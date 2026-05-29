# AI Prompt Editing — Clinical Review Sign-Off Process

## Scope

This process applies to any PR that modifies:

- `packages/ai-prompts/src/drug-class-anchors.ts` (drug class cross-reaction data)
- `packages/ai-prompts/src/clinical-review.ts` (system prompt or user prompt templates)
- Any other file under `packages/ai-prompts/src/` that affects the text sent to the LLM

## Why This Exists

The clinical review prompt drives the AI oversight engine that flags potential
patient safety concerns. Hard-coded clinical knowledge (drug class
cross-reactions, allergy categories, severity definitions) directly affects
whether real safety gaps are caught or missed. Changes to this data must be
reviewed with the same rigor as any clinical decision rule.

## Sign-Off Checklist

Every PR touching the files listed above MUST include the following in the PR
description:

### 1. Clinical accuracy

- [ ] Each added or modified drug class / cross-reaction is documented in at
      least one standard reference (Lexicomp, Micromedex, FDA labeling, or
      peer-reviewed literature).
- [ ] The reference is cited in the PR description (title, year, and section
      or table number).

### 2. Prompt version bump

- [ ] `PROMPT_VERSION` in `clinical-review.ts` has been incremented.
- [ ] The version follows semver: patch for wording-only tweaks, minor for
      new drug classes or removed entries, major for structural prompt changes.

### 3. Test coverage

- [ ] The test file `__tests__/clinical-review-prompt.test.ts` has assertions
      verifying every entry in `DRUG_CLASS_CROSS_REACTIONS` appears in the
      rendered prompt.
- [ ] Any new clinical logic has a corresponding test case.

### 4. Downstream impact review

- [ ] The author has confirmed that no deterministic rule in
      `services/ai-oversight/src/rules/` duplicates or conflicts with the
      changed prompt content.
- [ ] If a new drug class is added, the `medication-safety` category validator
      in `services/ai-oversight` still accepts the expected flag shape.

### 5. Reviewer requirements

CareBridge is pre-launch and currently does not have an on-staff clinician.
The reviewer requirement is split into a **merge gate** (must hold before the
PR lands on `main`) and a **launch gate** (must hold before live patient use).

**Merge gate (required for every PR):**

- [ ] At least one engineering reviewer has approved the code change.
- [ ] Sections 1–4 above are complete, including primary-source citations
      (FDA labeling, WHO/CDC reference data, Lexicomp/Micromedex, or
      peer-reviewed literature) for any clinical content.

**Launch gate (required before production patient use):**

- [ ] A reviewer with clinical domain knowledge (physician, PharmD, or
      clinical informaticist) has attested to the clinical content of every
      merged `clinical-safety` PR.

When a clinical-safety PR is merged pre-launch, the author MUST add an entry
to [`LAUNCH-CHECKLIST.md`](../LAUNCH-CHECKLIST.md) so the clinician
attestation can be done in batch before launch. The merged commit serves as
the audit trail; the launch checklist tracks what still needs walk-through.

## Quick Reference — Adding a Drug Class

1. Add an entry to `DRUG_CLASS_CROSS_REACTIONS` in
   `packages/ai-prompts/src/drug-class-anchors.ts`.
2. Bump `PROMPT_VERSION` (minor version).
3. Run `pnpm --filter @carebridge/ai-prompts test` to confirm the new entry
   is rendered into the prompt.
4. Open a PR with the sign-off checklist above filled in.
