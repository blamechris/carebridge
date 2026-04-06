# Oversight's Audit: CareBridge Post-Remediation

**Agent**: Oversight — LLM prompt safety, hallucination risk, clinical AI reliability
**Overall Rating**: 3.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Prompt construction | 3.5/5 | Sanitization added; semantic injection still possible via JSON values |
| PHI redaction | 4/5 | Now wired; covers providers/ages; misses patient names/MRNs |
| LLM response validation | 3/5 | Validator called; "medication-safety" category missing from enum |
| Flag severity/category | 2.5/5 | Validator missing new category; cast without fallback |
| Deterministic rules | 4.5/5 | Anticoagulant rule added; CHEMO-NEUTRO-FEVER has ANC blind spot |
| Flag deduplication | 3.5/5 | Within-job fixed; cross-job relies on category+severity |
| Token budget truncation | 3/5 | Silent truncation can cut mid-diagnosis |
| Claude API error handling | 2.5/5 | Retries present; rate-limit errors not separated |
| Context assembly | 3.5/5 | triggerEvent.data sanitized but semantically vulnerable |
| Cross-job isolation | 3/5 | No transactional consistency between rule/LLM context queries |

---

## Top 5 Findings

### Finding 1 — "medication-safety" Missing from Validator Enum
**Files:** `packages/phi-sanitizer/src/llm-validator.ts:10-17`, `packages/validators/src/ai-flags.ts:4-7`
New ONCO-ANTICOAG-HELD-001 rule returns "medication-safety" but validator doesn't recognize it.

### Finding 2 — Semantic Prompt Injection via JSON Free Text
**File:** `services/ai-oversight/src/workers/context-builder.ts:194`
triggerEvent.data JSON-stringified into prompt. sanitizeFreeText catches ChatML delimiters but not semantic injection ("Ignore previous instructions...").

### Finding 3 — Rate-Limit Errors Not Separated from Transient
**File:** `services/ai-oversight/src/services/claude-client.ts:87-93`
429 responses retried immediately instead of respecting Retry-After header.

### Finding 4 — Category Cast Without Type Guard
**File:** `services/ai-oversight/src/services/review-service.ts:161-168`
`finding.category as ClinicalFlagCategory` cast bypasses runtime validation.

### Finding 5 — CHEMO-NEUTRO-FEVER Rule Doesn't Check ANC
**File:** `services/ai-oversight/src/rules/cross-specialty.ts:156-178`
Rule fires on chemo+fever without checking neutrophil count. Name is misleading.
