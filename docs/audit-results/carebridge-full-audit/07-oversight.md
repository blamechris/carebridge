# Oversight's Audit: CareBridge AI Oversight Engine

**Agent**: Oversight — LLM prompt safety, hallucination risk, prompt injection, response validation
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-05

## Section Ratings

### 1. Prompt Design & Injection Surface — 2/5
- `buildReviewPrompt()` interpolates raw DB strings without sanitization
- `context.triggering_event.detail` = `JSON.stringify(triggerEvent.data)` — entire raw event verbatim
- `event.data.subjective` (free-text SOAP note) flows into LLM prompt as-is
- System prompt has no anti-injection directive ("treat clinical data as data, not instructions")
- Plain text format — no structural barriers between clinical context and injected instructions

### 2. Claude API Response Validation — 2/5
- `parseReviewResponse()` filter only checks field existence, not validity
- `severity: "URGENT"` (hallucinated) passes the filter
- `as ClinicalFlagCategory` cast at `review-service.ts:128` erases TypeScript safety
- `notify_specialties: "neurology"` (string not array) passes — dispatch iterates char-by-char
- Markdown-wrapped response (` ```json `) silently returns `[]`
- **No distinction between "LLM found nothing" and "LLM response was unparseable"**

### 3. Hallucination Risk & Output Containment — 2/5
- No post-generation plausibility checks
- No severity cap — hallucinated `"critical"` flag indistinguishable from rule-generated
- No finding count ceiling — 50 hallucinated findings create 50 flags
- `model_id` hardcoded as string literal in `review-service.ts:136` — audit trail wrong if model changes

### 4. Context Integrity — 3/5
- Context builder DB queries are sound (parallel fetch)
- No size limits — complex patient may exceed 4096 tokens → truncated JSON → silent `[]`
- `recent_flags` fetches all statuses but prompt only shows "open" — LLM re-flags dismissed concerns
- N+1 queries for labs and care team names

### 5. Deduplication Logic — 2/5
- False negatives: word-overlap heuristic easily defeated by paraphrasing
- **False positives (dangerous)**: `category + severity` match suppresses ANY LLM finding if a rule fired same category/severity — unrelated critical concerns silently dropped
- No persistence-layer check — retry of same event creates duplicate flags

### 6. Deterministic Rule Coverage — 3/5
- Cross-specialty rules clinically sound
- Critical values use 2× heuristic not named thresholds — misses K+ 6.4 mEq/L
- **All cross-specialty rules inert for non-symptom events** — `lab.resulted`, `diagnosis.added` never trigger rules regardless of risk profile
- No allergy + medication check rule
- No anticoagulation + procedure rule

### 7. Error Handling & Audit Trail — 3/5
- `try/catch` correctly records `status: "failed"` and re-throws for BullMQ retry
- Raw LLM response never stored — can't debug what Claude actually said
- `context_hash` field defined but never populated
- Token counts available from SDK but never recorded

## Top 5 Findings

1. **Prompt injection via clinical note free text** — `clinical-review.ts:113` + `context-builder.ts:193` — direct patient safety impact
2. **Silent parse failure logged as "completed"** — `clinical-review.ts:128-141` — invisible patient safety gap, undetectable degradation
3. **LLM output written to DB without schema validation** — `review-service.ts:128` `as ClinicalFlagCategory` — corrupt data enters clinical record
4. **Deduplication suppresses unrelated critical LLM findings** — `review-service.ts:297-304` — false positive dedup on category+severity
5. **Cross-specialty rules inert for non-symptom events** — `review-service.ts:233-263` — cancer patient gets new lab result → DVT rule doesn't fire

## Overall Rating: 2.5/5

Architecture of the oversight engine is sound. The deterministic rules have genuine clinical value. But the implementation has multiple compounding issues: the prompt injection surface is wide open, LLM output bypasses schema validation, parse failures are invisible, and the dedup logic actively suppresses legitimate critical findings. All fixable with targeted changes — none require architectural rethinking.
