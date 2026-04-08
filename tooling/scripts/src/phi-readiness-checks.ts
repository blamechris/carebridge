/**
 * PHI readiness gate — Phase D prerequisite checks.
 *
 * This module contains pure check functions that validate the repository
 * and environment meet the HIPAA-hardening requirements from Phase D of
 * the clinical AI plan. The checks are organised into two modes:
 *
 *   STATIC  — run in CI on every PR. No env / DB required. Walks the
 *             repository and asserts the kill-switch is still wired,
 *             the redactor still exports the expanded functions, the
 *             migration file exists, no secrets have been committed, etc.
 *             Any regression fails the build and blocks merge.
 *
 *   RUNTIME — run at deploy time against the target environment. Needs
 *             DATABASE_URL and the PHI_* env vars. Verifies the kill-switch
 *             env matches policy, the DB has migration 0011 applied, and
 *             (if any clinical_notes exist) their sections column holds
 *             ciphertext, not plaintext JSON — i.e. the re-encryption
 *             script has been run.
 *
 * Each check returns a {@link CheckResult}. The main script aggregates
 * them and exits 1 if any fail.
 *
 * Design:
 *   - Check functions are PURE — they take explicit inputs (file contents,
 *     env objects, fake sql clients). No hidden I/O. This keeps them
 *     trivially unit-testable and prevents flakes.
 *   - The CLI wrapper (phi-readiness-check.ts) does the file and DB I/O
 *     and hands the results to the pure functions.
 *   - No PHI is ever logged. Checks report structural facts only.
 */

export type CheckResult =
  | { ok: true; name: string; detail?: string }
  | { ok: false; name: string; reason: string };

export function pass(name: string, detail?: string): CheckResult {
  return { ok: true, name, detail };
}

export function fail(name: string, reason: string): CheckResult {
  return { ok: false, name, reason };
}

// ---------------------------------------------------------------------------
// Static checks — operate on file contents passed in by the caller.
// ---------------------------------------------------------------------------

/**
 * The kill-switch must remain wired into the Claude client. If these
 * identifiers disappear, the `AI_OVERSIGHT_LLM_ENABLED` / BAA gate has
 * been removed or renamed — a blocker for Phase A shipping PHI to Claude.
 */
export function checkKillSwitchInClaudeClient(
  claudeClientSource: string,
): CheckResult {
  const required = [
    "AI_OVERSIGHT_LLM_ENABLED",
    "AI_OVERSIGHT_BAA_ACKNOWLEDGED",
    "assertLLMEnabled",
    "LLMDisabledError",
  ];
  const missing = required.filter((id) => !claudeClientSource.includes(id));
  if (missing.length > 0) {
    return fail(
      "kill-switch: claude-client",
      `claude-client.ts is missing required identifiers: ${missing.join(", ")}`,
    );
  }
  return pass("kill-switch: claude-client");
}

/**
 * The review-service must invoke the kill-switch before dispatching to
 * Claude. Either a positive gate (`isLLMEnabled`) or an assertion
 * (`assertLLMEnabled`) counts — but at least one must be present.
 */
export function checkKillSwitchInReviewService(
  reviewServiceSource: string,
): CheckResult {
  const hasGate =
    reviewServiceSource.includes("isLLMEnabled") ||
    reviewServiceSource.includes("assertLLMEnabled");
  if (!hasGate) {
    return fail(
      "kill-switch: review-service",
      "review-service.ts does not reference isLLMEnabled or assertLLMEnabled — the kill-switch is no longer gating the Claude call path.",
    );
  }
  if (!reviewServiceSource.includes("LLMDisabledError")) {
    return fail(
      "kill-switch: review-service",
      "review-service.ts does not handle LLMDisabledError — defensive catch around reviewPatientRecord may be missing.",
    );
  }
  return pass("kill-switch: review-service");
}

/**
 * The worker boots with a status log so operators can see the kill-switch
 * state at startup. Missing means misconfiguration would be silent.
 */
export function checkBootTimeStatusLog(
  reviewWorkerSource: string,
): CheckResult {
  if (!reviewWorkerSource.includes("logLLMStatus")) {
    return fail(
      "kill-switch: worker boot log",
      "review-worker.ts does not call logLLMStatus() — operators will not see kill-switch state at boot.",
    );
  }
  return pass("kill-switch: worker boot log");
}

/**
 * The Phase A1 note-extractor must route its LLM call through the same
 * defense-in-depth stack as clinical review: PHI redaction via
 * redactClinicalText, fail-closed assertPromptSanitized, and the
 * kill-switch (isLLMEnabled / assertLLMEnabled). Dropping any of these
 * would silently weaken the protection on the highest-volume source of
 * PHI in the system (signed clinical notes).
 */
export function checkNoteExtractorGates(
  noteExtractorSource: string,
): CheckResult {
  const required = [
    "redactClinicalText",
    "assertPromptSanitized",
    "isLLMEnabled",
    "SanitizationError",
  ];
  const missing = required.filter((id) => !noteExtractorSource.includes(id));
  if (missing.length > 0) {
    return fail(
      "phase-a: note-extractor gates",
      `note-extractor.ts is missing required guards: ${missing.join(", ")}. ` +
        `The extractor must redact PHI, run the fail-closed sanitization check, ` +
        `and honour the LLM kill-switch before any Claude call.`,
    );
  }
  return pass("phase-a: note-extractor gates");
}

/**
 * The PHI redactor must export the Phase D expanded functions. If any
 * are missing, the redactor has regressed and diagnosis codes / SSNs
 * may leak to Claude.
 */
export function checkRedactorExports(redactorSource: string): CheckResult {
  const required = [
    "redactSSNs",
    "redactICD10Codes",
    "redactSNOMEDCodes",
    "SANITIZATION_GUARDS",
  ];
  const missing = required.filter((id) => !redactorSource.includes(id));
  if (missing.length > 0) {
    return fail(
      "redactor: Phase D exports",
      `redactor.ts is missing required exports: ${missing.join(", ")}`,
    );
  }
  return pass("redactor: Phase D exports");
}

/**
 * The sanitization guards must reference the expanded pattern set so the
 * fail-closed assertPromptSanitized check can catch leaks of the new
 * categories.
 */
export function checkSanitizationGuards(redactorSource: string): CheckResult {
  // Pull the SANITIZATION_GUARDS array body and verify expected patterns
  // are listed inside it. This is a structural check, not a runtime call.
  const match = redactorSource.match(/SANITIZATION_GUARDS\s*:?[^=]*=\s*\[([^\]]*)\]/s);
  if (!match) {
    return fail(
      "redactor: sanitization guards",
      "Could not locate SANITIZATION_GUARDS array in redactor.ts.",
    );
  }
  const guardsBody = match[1];
  const required = ["MRN_CONTEXT", "ICD10_DOTTED", "SNOMED_LABELED"];
  const missing = required.filter((id) => !guardsBody.includes(id));
  if (missing.length > 0) {
    return fail(
      "redactor: sanitization guards",
      `SANITIZATION_GUARDS is missing patterns: ${missing.join(", ")}. The fail-closed check will not catch leaks of these categories.`,
    );
  }
  return pass("redactor: sanitization guards");
}

/**
 * The .env.example file must document the kill-switch env vars and the
 * PHI HMAC key so operators setting up a new environment see them.
 */
export function checkEnvExampleDocuments(envExample: string): CheckResult {
  const required = [
    "AI_OVERSIGHT_LLM_ENABLED",
    "AI_OVERSIGHT_BAA_ACKNOWLEDGED",
    "PHI_ENCRYPTION_KEY",
    "PHI_HMAC_KEY",
  ];
  const missing = required.filter((id) => !envExample.includes(id));
  if (missing.length > 0) {
    return fail(
      "env: .env.example coverage",
      `.env.example is missing: ${missing.join(", ")}. New environments may ship with the kill-switch undocumented.`,
    );
  }
  return pass("env: .env.example coverage");
}

/**
 * `.env` must be gitignored so developers can't accidentally recommit
 * rotated secrets.
 */
export function checkEnvGitignored(gitignore: string): CheckResult {
  const lines = gitignore.split("\n").map((l) => l.trim());
  const hasEnv =
    lines.includes(".env") ||
    lines.includes("/.env") ||
    lines.includes("*.env") ||
    lines.some((l) => l === ".env.local" && lines.includes(".env"));
  if (!lines.includes(".env") && !lines.includes("/.env")) {
    return fail(
      "gitignore: .env",
      ".env is not listed in .gitignore — risk of recommitting rotated secrets.",
    );
  }
  return pass("gitignore: .env");
}

/**
 * No `.env` file should currently be tracked. The input is the list of
 * tracked paths (typically from `git ls-files`).
 */
export function checkNoEnvFilesTracked(
  trackedFiles: readonly string[],
): CheckResult {
  const leaked = trackedFiles.filter((f) => {
    const base = f.split("/").pop() ?? "";
    // .env.example and .env.test are acceptable; raw .env is not.
    if (base === ".env.example") return false;
    if (base === ".env.test") return false;
    if (base === ".env.schema") return false;
    return base === ".env" || base.startsWith(".env.");
  });
  if (leaked.length > 0) {
    return fail(
      "git: no .env tracked",
      `Tracked dotenv files found (should only be .env.example): ${leaked.join(", ")}`,
    );
  }
  return pass("git: no .env tracked");
}

/**
 * Scan tracked source files for bare 64-hex-char strings. Those are the
 * wire format for `PHI_ENCRYPTION_KEY`, and finding one in checked-in
 * code almost certainly indicates a hardcoded secret.
 *
 * This check is intentionally narrow: it only looks for the exact
 * 64-hex-char token pattern. Test files that legitimately use random
 * keys are excluded by the caller.
 */
const HEX64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

export function checkNoHardcodedHexKeys(
  files: readonly { path: string; content: string }[],
): CheckResult {
  const hits: string[] = [];
  for (const f of files) {
    if (HEX64.test(f.content)) hits.push(f.path);
  }
  if (hits.length > 0) {
    return fail(
      "secrets: no hardcoded hex keys",
      `Found 64-hex-char token(s) in tracked source (likely a hardcoded key): ${hits.join(", ")}`,
    );
  }
  return pass("secrets: no hardcoded hex keys");
}

/**
 * Verifies the migration 0011 file exists and still references the
 * encrypted column transforms. An empty or deleted file means the
 * encryption at-rest guarantee has regressed.
 */
export function checkMigration0011(migrationSource: string | null): CheckResult {
  if (migrationSource === null) {
    return fail(
      "migration: 0011 present",
      "0011_encrypt_clinical_narratives.sql not found.",
    );
  }
  // Must still reference both JSONB->text converts. If someone downgrades
  // the migration, sections columns may revert to plaintext jsonb.
  if (
    !migrationSource.includes('"clinical_notes"') ||
    !migrationSource.includes('"note_versions"') ||
    !migrationSource.includes("SET DATA TYPE text")
  ) {
    return fail(
      "migration: 0011 present",
      "0011_encrypt_clinical_narratives.sql no longer contains the expected column conversions.",
    );
  }
  return pass("migration: 0011 present");
}

/**
 * Verifies the re-encryption script exists with the expected entrypoint
 * and target list. Without it the migration 0011 rollout has no way to
 * encrypt existing plaintext rows.
 */
export function checkReEncryptionScript(
  scriptSource: string | null,
): CheckResult {
  if (scriptSource === null) {
    return fail(
      "script: re-encryption present",
      "packages/db-schema/src/encrypt-clinical-narratives.ts not found.",
    );
  }
  const required = [
    "MIGRATION_0011_TARGETS",
    "runMigration",
    "ENCRYPTED_PATTERN",
  ];
  const missing = required.filter((id) => !scriptSource.includes(id));
  if (missing.length > 0) {
    return fail(
      "script: re-encryption present",
      `encrypt-clinical-narratives.ts is missing: ${missing.join(", ")}`,
    );
  }
  return pass("script: re-encryption present");
}

// ---------------------------------------------------------------------------
// Runtime checks — operate on the current process env and a sql client.
// ---------------------------------------------------------------------------

export function checkPhiEncryptionKey(env: NodeJS.ProcessEnv): CheckResult {
  const key = env.PHI_ENCRYPTION_KEY;
  if (!key) {
    return fail(
      "runtime: PHI_ENCRYPTION_KEY",
      "PHI_ENCRYPTION_KEY is not set.",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    return fail(
      "runtime: PHI_ENCRYPTION_KEY",
      "PHI_ENCRYPTION_KEY is not 64 hex chars (expected 32 bytes hex-encoded).",
    );
  }
  return pass("runtime: PHI_ENCRYPTION_KEY");
}

export function checkPhiHmacKey(env: NodeJS.ProcessEnv): CheckResult {
  const hmacKey = env.PHI_HMAC_KEY;
  const encryptionKey = env.PHI_ENCRYPTION_KEY;
  const isProd = env.NODE_ENV === "production";

  if (!hmacKey) {
    if (isProd) {
      return fail(
        "runtime: PHI_HMAC_KEY",
        "PHI_HMAC_KEY is required in production (must be distinct from PHI_ENCRYPTION_KEY).",
      );
    }
    return pass("runtime: PHI_HMAC_KEY", "unset (non-production)");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hmacKey)) {
    return fail(
      "runtime: PHI_HMAC_KEY",
      "PHI_HMAC_KEY is not 64 hex chars.",
    );
  }
  if (encryptionKey && hmacKey === encryptionKey) {
    return fail(
      "runtime: PHI_HMAC_KEY",
      "PHI_HMAC_KEY must NOT equal PHI_ENCRYPTION_KEY. Rotate one of them.",
    );
  }
  return pass("runtime: PHI_HMAC_KEY");
}

/**
 * The kill-switch env vars must be explicitly set — even to "false" —
 * so that a misconfigured deploy with undefined env is caught immediately
 * instead of silently leaving the worker in rules-only mode.
 */
export function checkKillSwitchEnv(env: NodeJS.ProcessEnv): CheckResult {
  const enabled = env.AI_OVERSIGHT_LLM_ENABLED;
  const baa = env.AI_OVERSIGHT_BAA_ACKNOWLEDGED;

  if (enabled === undefined) {
    return fail(
      "runtime: kill-switch env",
      "AI_OVERSIGHT_LLM_ENABLED is unset. Set it explicitly to 'true' or 'false'.",
    );
  }
  if (enabled !== "true" && enabled !== "false") {
    return fail(
      "runtime: kill-switch env",
      `AI_OVERSIGHT_LLM_ENABLED must be 'true' or 'false', got: ${JSON.stringify(enabled)}`,
    );
  }
  if (baa === undefined) {
    return fail(
      "runtime: kill-switch env",
      "AI_OVERSIGHT_BAA_ACKNOWLEDGED is unset. Set it explicitly to 'true' or 'false'.",
    );
  }
  if (baa !== "true" && baa !== "false") {
    return fail(
      "runtime: kill-switch env",
      `AI_OVERSIGHT_BAA_ACKNOWLEDGED must be 'true' or 'false', got: ${JSON.stringify(baa)}`,
    );
  }

  if (enabled === "true" && baa !== "true") {
    return fail(
      "runtime: kill-switch env",
      "AI_OVERSIGHT_LLM_ENABLED is 'true' but AI_OVERSIGHT_BAA_ACKNOWLEDGED is not. The BAA prerequisite must be confirmed before enabling LLM review.",
    );
  }

  if (enabled === "true") {
    if (!env.ANTHROPIC_API_KEY) {
      return fail(
        "runtime: kill-switch env",
        "AI_OVERSIGHT_LLM_ENABLED is 'true' but ANTHROPIC_API_KEY is not set.",
      );
    }
  }

  return pass(
    "runtime: kill-switch env",
    `llm=${enabled}, baa=${baa}`,
  );
}

// ---------------------------------------------------------------------------
// Runtime DB checks — operate on a minimal sql interface so they can be
// unit-tested with a fake client.
// ---------------------------------------------------------------------------

export interface SqlClient {
  unsafe: (
    query: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
}

/**
 * Verifies the drizzle migrations journal records migration 0011 as
 * applied. Drizzle stores its journal in `drizzle.__drizzle_migrations`
 * by default.
 */
export async function checkMigration0011Applied(
  sql: SqlClient,
): Promise<CheckResult> {
  try {
    const rows = await sql.unsafe(
      `SELECT hash FROM drizzle.__drizzle_migrations WHERE hash LIKE $1 OR hash LIKE $2`,
      ["%0011_encrypt_clinical_narratives%", "%0011_encrypt%"],
    );
    if (rows.length === 0) {
      return fail(
        "runtime: migration 0011 applied",
        "drizzle.__drizzle_migrations does not contain migration 0011. Run `pnpm db:migrate` before deploying.",
      );
    }
    return pass("runtime: migration 0011 applied");
  } catch (err) {
    return fail(
      "runtime: migration 0011 applied",
      `Could not query drizzle migrations journal: ${(err as Error).message}`,
    );
  }
}

/**
 * Samples a clinical_notes row and verifies its `sections` column holds
 * ciphertext (matches the iv:authTag:ct format) rather than plaintext
 * JSON. If the re-encryption script has NOT been run after migration
 * 0011, existing rows will still be plaintext JSON and this check will
 * fail.
 *
 * If the table has no rows, the check passes (nothing to verify) with
 * an informational detail.
 */
const CIPHERTEXT_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/;

export async function checkClinicalNotesSectionsEncrypted(
  sql: SqlClient,
): Promise<CheckResult> {
  try {
    const rows = await sql.unsafe(
      `SELECT id, sections FROM clinical_notes LIMIT 5`,
    );
    if (rows.length === 0) {
      return pass(
        "runtime: clinical_notes.sections encrypted",
        "table empty, nothing to verify",
      );
    }
    const plaintextRows: string[] = [];
    for (const row of rows) {
      const value = row.sections;
      if (typeof value !== "string") {
        plaintextRows.push(String(row.id));
        continue;
      }
      if (!CIPHERTEXT_FORMAT.test(value)) {
        plaintextRows.push(String(row.id));
      }
    }
    if (plaintextRows.length > 0) {
      return fail(
        "runtime: clinical_notes.sections encrypted",
        `Found ${plaintextRows.length} row(s) with non-ciphertext sections (ids: ${plaintextRows.join(", ")}). Run the re-encryption script: pnpm --filter @carebridge/db-schema encrypt:0011`,
      );
    }
    return pass("runtime: clinical_notes.sections encrypted");
  } catch (err) {
    return fail(
      "runtime: clinical_notes.sections encrypted",
      `Could not sample clinical_notes: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Result aggregation helpers.
// ---------------------------------------------------------------------------

export interface AggregateReport {
  readonly results: readonly CheckResult[];
  readonly passed: number;
  readonly failed: number;
}

export function aggregate(results: readonly CheckResult[]): AggregateReport {
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.ok) passed++;
    else failed++;
  }
  return { results, passed, failed };
}

export function formatReport(report: AggregateReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    if (r.ok) {
      lines.push(`  OK   ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    } else {
      lines.push(`  FAIL ${r.name}`);
      lines.push(`       → ${r.reason}`);
    }
  }
  lines.push("");
  lines.push(
    `${report.passed} passed, ${report.failed} failed (${report.results.length} total)`,
  );
  return lines.join("\n");
}
