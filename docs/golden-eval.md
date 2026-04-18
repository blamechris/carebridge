# Golden-Eval Harness

The golden-eval harness is a record-and-replay test suite for the clinical-review
prompt builder (`@carebridge/ai-prompts`). It validates that `buildReviewPrompt`
produces structurally correct, token-budget-compliant prompts containing all
clinically relevant data. No live API calls are made — the harness tests prompt
assembly only.

## How it works

Each fixture file in `packages/ai-prompts/evals/fixtures/` describes a clinical
scenario (patient context + expected outcomes). The test runner loads every
fixture, feeds its `context` into `buildReviewPrompt`, and checks that:

1. All required section headers are present (Demographics, Diagnoses, Allergies, etc.)
2. All strings listed in `expected.mustMentionInPrompt` appear in the generated prompt
3. All active medications and triggering-event details are rendered
4. The prompt fits within `DEFAULT_TOKEN_BUDGET`
5. `enforceTokenBudget` does not truncate within-budget prompts
6. Negative-case fixtures (shouldFlag: false) carry the correct `forbiddenCategories`

## CI integration

The golden-eval tests run as part of the monorepo-wide `pnpm test` command in the
CI workflow (`.github/workflows/ci.yml`). There is no separate path-filtered job;
any change that breaks prompt assembly will fail the existing Test job.

## Fixture JSON schema

Each fixture file must conform to the `EvalFixture` interface defined in
`packages/ai-prompts/evals/eval-runner.ts`:

```jsonc
{
  // Unique identifier for this scenario
  "id": "penicillin-allergy-on-amoxicillin",

  // Human-readable description of what this fixture tests
  "description": "Patient with confirmed penicillin allergy prescribed amoxicillin",

  // Full ReviewContext passed to buildReviewPrompt
  "context": {
    "patient": {
      "age": 45,
      "sex": "female",
      "allergy_status": "known",        // "nkda" | "known" | "unknown"
      "active_diagnoses": ["..."],
      "allergies": [
        {
          "substance": "Penicillin",
          "reaction": "Anaphylaxis",
          "criticality": "high",
          "verification_status": "confirmed"
        }
      ]
    },
    "active_medications": [
      {
        "name": "Amoxicillin",
        "dose": "500 mg",
        "route": "oral",
        "frequency": "TID",
        "started_at": "2026-04-15"       // ISO 8601 date
      }
    ],
    "latest_vitals": {
      "blood_pressure": { "value": 120, "unit": "mmHg systolic", "recorded_at": "..." },
      "heart_rate":     { "value": 78,  "unit": "bpm",           "recorded_at": "..." },
      "temperature":    { "value": 37.0,"unit": "C",             "recorded_at": "..." }
    },
    "recent_labs": [
      {
        "test_name": "WBC",
        "value": 8.5,
        "unit": "x10^9/L",
        "flag": null,                    // null | "HIGH" | "LOW" | "CRITICAL"
        "collected_at": "2026-04-14"
      }
    ],
    "triggering_event": {
      "type": "medication_order",        // e.g. "medication_order", "symptom_report", "lab_result"
      "summary": "Short one-line summary",
      "detail": "Detailed clinical narrative"
    },
    "recent_flags": [],
    "care_team": [
      {
        "name": "Dr. Smith",
        "specialty": "Hematology/Oncology",
        "recent_note_date": "2026-04-14"
      }
    ]
  },

  // Expected outcomes
  "expected": {
    "shouldFlag": true,                  // true = scenario should produce a clinical flag
    "expectedCategories": ["medication-safety"],   // optional, categories the flag should have
    "forbiddenCategories": [],           // optional, categories that must NOT appear
    "minimumSeverity": "critical",       // optional, "critical" | "warning" | "info"
    "mustMentionInPrompt": [             // strings that MUST appear in the generated prompt
      "Penicillin",
      "Amoxicillin"
    ]
  }
}
```

### Field reference for `expected`

| Field                 | Required | Purpose |
|-----------------------|----------|---------|
| `shouldFlag`          | yes      | Whether this scenario should produce a clinical flag |
| `expectedCategories`  | no       | Flag categories expected (e.g. `cross-specialty`, `drug-interaction`) |
| `forbiddenCategories` | no       | Flag categories that must NOT be assigned (negative-case guardrail) |
| `minimumSeverity`     | no       | Minimum severity the flag should carry |
| `mustMentionInPrompt` | yes      | Literal strings that must appear in the generated prompt text |

## Adding a new scenario

1. Create a new JSON file in `packages/ai-prompts/evals/fixtures/`. The filename
   is not significant but should be descriptive (e.g. `lithium-renal-check.json`).
2. Populate the fixture following the schema above. Use an existing fixture as a
   template.
3. Set `mustMentionInPrompt` to the key clinical terms the prompt must contain
   (drug names, diagnoses, lab values).
4. For negative cases (scenarios that should NOT produce a flag), set
   `shouldFlag: false` and list guardrail categories in `forbiddenCategories`.
5. Run the tests locally:
   ```bash
   pnpm --filter @carebridge/ai-prompts test
   ```
6. The test in `golden-eval.test.ts` auto-discovers fixtures via `loadFixtures()`,
   so no imports or test-file changes are needed.

## Re-recording fixtures

Fixtures are static JSON — there is no "recording" step against a live API.
To update a fixture after a schema change:

1. Identify which fields changed in `ReviewContext` (defined in
   `packages/ai-prompts/src/clinical-review.ts`).
2. Update the `context` object in affected fixture files to match the new schema.
3. If prompt section headers changed (e.g. `PROMPT_SECTIONS` in
   `packages/ai-prompts/src/prompt-sections.ts`), update the hardcoded header
   checks in `golden-eval.test.ts`.
4. Run the tests to verify everything passes.

## Interpreting failures

| Failure pattern | Likely cause |
|----------------|--------------|
| `Expected prompt to mention "X"` | `buildReviewPrompt` no longer renders a clinical value that the fixture expects. Check if the field was renamed, moved, or omitted. |
| `Missing required section header: "Y"` | A prompt section header constant changed. Update `PROMPT_SECTIONS` or the fixture's `mustMentionInPrompt`. |
| `Prompt exceeds token budget` | New context fields pushed the prompt past `DEFAULT_TOKEN_BUDGET`. Consider adjusting the budget or trimming verbose sections. |
| `enforceTokenBudget truncated a prompt that was within budget` | Bug in the truncation logic — it should only truncate over-budget prompts. |
| `loads all six fixture files` fails | A fixture file was added or removed without updating the count assertion in the test. Update the expected count. |
| Negative-case assertion fails | A `forbiddenCategories` entry is missing from a negative fixture, or `shouldFlag` was set incorrectly. |
