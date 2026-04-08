# PHI Readiness Gate

The PHI readiness gate is the Phase D HIPAA hardening checkpoint. It blocks
code and deploys that would ship Phase A/B/C features (semantic note
correlation, patient check-ins, cross-team view) into a PHI-bearing
environment before the supporting controls are in place.

It runs in two modes, with non-overlapping scopes.

## Static mode — CI

Runs on every pull request as the `phi-readiness` job in
`.github/workflows/ci.yml`. No environment variables or database access
required. Only reads the working tree.

Invoke locally:

```bash
pnpm phi:gate
```

### Checks

| Name | What it asserts |
|------|-----------------|
| kill-switch: claude-client | `claude-client.ts` still references `AI_OVERSIGHT_LLM_ENABLED`, `AI_OVERSIGHT_BAA_ACKNOWLEDGED`, `assertLLMEnabled`, and `LLMDisabledError`. Removing any of these regresses the Phase D dual-flag kill-switch. |
| kill-switch: review-service | `review-service.ts` calls `isLLMEnabled` or `assertLLMEnabled` and handles `LLMDisabledError` in a defensive catch. |
| kill-switch: worker boot log | `review-worker.ts` calls `logLLMStatus()` on boot so operators can see kill-switch state. |
| redactor: Phase D exports | `redactor.ts` still exports `redactSSNs`, `redactICD10Codes`, `redactSNOMEDCodes`, and `SANITIZATION_GUARDS`. |
| redactor: sanitization guards | `SANITIZATION_GUARDS` includes `MRN_CONTEXT`, `ICD10_DOTTED`, and `SNOMED_LABELED` so `assertPromptSanitized` catches leaks of those categories. |
| env: .env.example coverage | `.env.example` documents `PHI_ENCRYPTION_KEY`, `PHI_HMAC_KEY`, `AI_OVERSIGHT_LLM_ENABLED`, and `AI_OVERSIGHT_BAA_ACKNOWLEDGED`. |
| gitignore: .env | `.env` is listed in `.gitignore`. |
| migration: 0011 present | `0011_encrypt_clinical_narratives.sql` exists and still references the `clinical_notes` / `note_versions` text transforms. |
| script: re-encryption present | `packages/db-schema/src/encrypt-clinical-narratives.ts` exists and exports `MIGRATION_0011_TARGETS`, `runMigration`, and `ENCRYPTED_PATTERN`. |
| git: no .env tracked | No `.env` files (other than `.env.example` / `.env.test`) appear in `git ls-files`. |
| secrets: no hardcoded hex keys | No 64-hex-char tokens appear in tracked source files (excluding tests, lockfiles, and the checker itself). |

A regression in any of these fails the CI job and blocks merge. The checks
are intentionally narrow and structural — they catch removal or renaming
of critical identifiers, not semantic correctness. Unit tests for the
identifiers' behaviour live in the respective packages.

## Runtime mode — deploy pipeline

Runs in the deploy pipeline against the target environment. Requires
`DATABASE_URL`, `PHI_ENCRYPTION_KEY`, and the kill-switch env vars.
Opens a short-lived DB connection to verify migration and ciphertext state.

Invoke:

```bash
DATABASE_URL=postgres://... \
PHI_ENCRYPTION_KEY=<64-hex> \
PHI_HMAC_KEY=<64-hex> \
AI_OVERSIGHT_LLM_ENABLED=<true|false> \
AI_OVERSIGHT_BAA_ACKNOWLEDGED=<true|false> \
  pnpm phi:gate:runtime
```

### Checks

| Name | What it asserts |
|------|-----------------|
| runtime: PHI_ENCRYPTION_KEY | Set and 64 hex chars (32 bytes). |
| runtime: PHI_HMAC_KEY | Required in `NODE_ENV=production`, must be 64 hex chars, and must NOT equal `PHI_ENCRYPTION_KEY`. Informational pass in non-production. |
| runtime: kill-switch env | Both `AI_OVERSIGHT_LLM_ENABLED` and `AI_OVERSIGHT_BAA_ACKNOWLEDGED` are explicitly set to `"true"` or `"false"`. If LLM is enabled, BAA must be acknowledged and `ANTHROPIC_API_KEY` must be set. |
| runtime: migration 0011 applied | `drizzle.__drizzle_migrations` records migration 0011 as applied. |
| runtime: clinical_notes.sections encrypted | A sample of up to 5 rows from `clinical_notes` all hold ciphertext matching `iv:authTag:ct`. Fails if any row still holds plaintext JSON — indicating the re-encryption script (`pnpm --filter @carebridge/db-schema encrypt:0011`) was not run. Empty tables pass with an informational note. |

Runtime checks return non-zero on the first failure and log only
structural facts — never PHI payloads.

## Phase D checklist

The gate is the code-and-environment enforcement of the broader Phase D
checklist. Items marked `(gated)` are enforced by the readiness gate;
items marked `(operational)` are ops/legal work that the gate cannot
verify and must be tracked manually.

- [ ] **(operational)** Anthropic BAA executed — see `docs/anthropic-baa.md`
- [x] **(gated)** LLM kill-switch wired and tested (static + runtime)
- [x] **(gated)** PHI redactor covers SSN, ICD-10, SNOMED CT diagnosis codes
- [x] **(gated)** Migration 0011 applied and re-encryption script run
- [ ] **(operational)** Four secrets from git history rotated
      (`PHI_ENCRYPTION_KEY`, `JWT_SECRET`, `REDIS_PASSWORD`, `SESSION_SECRET`)
- [x] **(gated)** CI PHI readiness job blocks merge on regression

## Adding a new check

1. Add a pure function to `tooling/scripts/src/phi-readiness-checks.ts`
   that returns `CheckResult`. Keep it pure — take explicit inputs, no
   I/O — so it can be unit-tested.
2. Add the file read / env lookup / SQL query to the CLI wrapper in
   `tooling/scripts/src/phi-readiness-check.ts`.
3. Add unit tests in
   `tooling/scripts/src/__tests__/phi-readiness-checks.test.ts`.
4. Document the check in this file under the appropriate mode.
