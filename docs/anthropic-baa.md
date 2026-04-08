# Anthropic BAA & Vendor Data Handling

## Status

**Required before any production PHI traffic reaches the Claude API.**

The CareBridge `ai-oversight` service sends clinical context (post-redaction)
to the Anthropic Claude API via `services/ai-oversight/src/services/claude-client.ts`.
Even after `phi-sanitizer` redaction, the residual quasi-identifier surface
(diagnoses, medications, symptom free-text) means we treat outbound prompts
as PHI for compliance purposes.

## Required Vendor Controls

1. **Business Associate Agreement (BAA)** signed with Anthropic, PBC,
   covering the Claude API endpoints used by `claude-client.ts`.
2. **Zero data retention** enabled on the API key / organization tier so
   prompts and responses are not retained for training or abuse monitoring
   beyond the request lifecycle.
3. **API key scoping**: production key restricted to the ai-oversight VPC
   egress; never used in dev/staging.
4. **Model pinning**: `DEFAULT_MODEL` in `claude-client.ts` must reference
   a model covered by the BAA. Currently `claude-sonnet-4-6`.

## Operational Requirements

- The `assertPromptSanitized()` fail-closed guard in
  `packages/phi-sanitizer/src/redactor.ts` MUST remain enabled in production.
- Every outbound prompt is recorded (post-redaction) in `review_jobs.redacted_prompt`
  for breach forensics under §164.308(a)(6).
- Vendor incidents (Anthropic security advisories) are tracked in
  the security runbook and require a 60-day breach notification review.

## Verification Checklist

- [ ] BAA executed and stored in `legal/vendor-agreements/anthropic-baa.pdf`
- [ ] Zero-retention confirmation email from Anthropic on file
- [ ] Production API key rotated post-BAA execution
- [ ] `.env.production` references the BAA-covered key only
- [ ] Quarterly review of outbound prompt sample for residual PHI

## Until BAA Is in Place

The LLM review path must be disabled in any environment with real PHI.
The Phase D kill-switch uses two env vars that both default to failing
closed:

- `AI_OVERSIGHT_LLM_ENABLED=false` — operator-facing feature flag
- `AI_OVERSIGHT_BAA_ACKNOWLEDGED=false` — legal prerequisite flag

Both must be `"true"` for the worker to send prompts to Claude. If
either is unset or not `"true"`, the worker gracefully degrades to
deterministic rules and logs `LLMDisabledError` through the review-job
status. The split lets ops enable the feature without inadvertently
bypassing the BAA gate.

The PHI readiness gate (`pnpm phi:gate:runtime`) verifies that these
env vars are explicitly set and that `AI_OVERSIGHT_LLM_ENABLED=true`
is accompanied by `AI_OVERSIGHT_BAA_ACKNOWLEDGED=true`. See
`docs/phi-readiness.md` for the full check list.
