/**
 * PHI readiness gate CLI.
 *
 * Runs the checks defined in phi-readiness-checks.ts against either the
 * repository (static mode, no env required) or the live environment
 * (runtime mode, requires DATABASE_URL and PHI_* vars).
 *
 * Usage:
 *   pnpm --filter @carebridge/scripts phi:readiness:static
 *   pnpm --filter @carebridge/scripts phi:readiness:runtime
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one check failed
 *   2 — usage error (bad flags, missing required env in runtime mode)
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  aggregate,
  checkBootTimeStatusLog,
  checkClinicalNotesSectionsEncrypted,
  checkEnvExampleDocuments,
  checkEnvGitignored,
  checkKillSwitchEnv,
  checkKillSwitchInClaudeClient,
  checkKillSwitchInReviewService,
  checkMigration0011,
  checkMigration0011Applied,
  checkNoEnvFilesTracked,
  checkNoHardcodedHexKeys,
  checkNoteExtractorGates,
  checkPhiEncryptionKey,
  checkPhiHmacKey,
  checkReEncryptionScript,
  checkRedactorExports,
  checkSanitizationGuards,
  formatReport,
  type CheckResult,
  type SqlClient,
} from "./phi-readiness-checks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root relative to this file (tooling/scripts/src → repo root). */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listTrackedFiles(): string[] {
  try {
    const output = execSync("git ls-files", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return output.split("\n").filter(Boolean);
  } catch (err) {
    console.error("Warning: failed to list tracked files:", (err as Error).message);
    return [];
  }
}

async function runStaticChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const claudeClientPath = join(
    REPO_ROOT,
    "services/ai-oversight/src/services/claude-client.ts",
  );
  const reviewServicePath = join(
    REPO_ROOT,
    "services/ai-oversight/src/services/review-service.ts",
  );
  const reviewWorkerPath = join(
    REPO_ROOT,
    "services/ai-oversight/src/workers/review-worker.ts",
  );
  const redactorPath = join(
    REPO_ROOT,
    "packages/phi-sanitizer/src/redactor.ts",
  );
  const envExamplePath = join(REPO_ROOT, ".env.example");
  const gitignorePath = join(REPO_ROOT, ".gitignore");
  const migrationPath = join(
    REPO_ROOT,
    "packages/db-schema/drizzle/0011_encrypt_clinical_narratives.sql",
  );
  const reEncryptScriptPath = join(
    REPO_ROOT,
    "packages/db-schema/src/encrypt-clinical-narratives.ts",
  );
  const noteExtractorPath = join(
    REPO_ROOT,
    "services/ai-oversight/src/extractors/note-extractor.ts",
  );

  const claudeClient = readIfExists(claudeClientPath);
  const reviewService = readIfExists(reviewServicePath);
  const reviewWorker = readIfExists(reviewWorkerPath);
  const redactor = readIfExists(redactorPath);
  const envExample = readIfExists(envExamplePath);
  const gitignore = readIfExists(gitignorePath);
  const migration = readIfExists(migrationPath);
  const reEncryptScript = readIfExists(reEncryptScriptPath);
  const noteExtractor = readIfExists(noteExtractorPath);

  if (claudeClient === null) {
    results.push({
      ok: false,
      name: "kill-switch: claude-client",
      reason: `File not found: ${claudeClientPath}`,
    });
  } else {
    results.push(checkKillSwitchInClaudeClient(claudeClient));
  }

  if (reviewService === null) {
    results.push({
      ok: false,
      name: "kill-switch: review-service",
      reason: `File not found: ${reviewServicePath}`,
    });
  } else {
    results.push(checkKillSwitchInReviewService(reviewService));
  }

  if (reviewWorker === null) {
    results.push({
      ok: false,
      name: "kill-switch: worker boot log",
      reason: `File not found: ${reviewWorkerPath}`,
    });
  } else {
    results.push(checkBootTimeStatusLog(reviewWorker));
  }

  if (redactor === null) {
    results.push({
      ok: false,
      name: "redactor: Phase D exports",
      reason: `File not found: ${redactorPath}`,
    });
  } else {
    results.push(checkRedactorExports(redactor));
    results.push(checkSanitizationGuards(redactor));
  }

  if (envExample === null) {
    results.push({
      ok: false,
      name: "env: .env.example coverage",
      reason: `File not found: ${envExamplePath}`,
    });
  } else {
    results.push(checkEnvExampleDocuments(envExample));
  }

  if (gitignore === null) {
    results.push({
      ok: false,
      name: "gitignore: .env",
      reason: `File not found: ${gitignorePath}`,
    });
  } else {
    results.push(checkEnvGitignored(gitignore));
  }

  results.push(checkMigration0011(migration));
  results.push(checkReEncryptionScript(reEncryptScript));

  if (noteExtractor === null) {
    results.push({
      ok: false,
      name: "phase-a: note-extractor gates",
      reason: `File not found: ${noteExtractorPath}`,
    });
  } else {
    results.push(checkNoteExtractorGates(noteExtractor));
  }

  const trackedFiles = listTrackedFiles();
  results.push(checkNoEnvFilesTracked(trackedFiles));

  // Hardcoded-key scan: narrow to likely-offending file types. Exclude tests,
  // node_modules, dist, lockfiles, and this script itself (which contains a
  // regex literal for 64-hex detection that would self-match otherwise).
  const HEX_SCAN_EXCLUDES = [
    /\/node_modules\//,
    /\/dist\//,
    /\.lock$/,
    /\.lockfile$/,
    /pnpm-lock\.yaml$/,
    /package-lock\.json$/,
    /__tests__\//,
    /\.test\.(ts|js)$/,
    /\.spec\.(ts|js)$/,
    /phi-readiness-checks\.ts$/,
    /phi-readiness-check\.ts$/,
  ];
  const hexScanCandidates = trackedFiles.filter((f) => {
    if (HEX_SCAN_EXCLUDES.some((r) => r.test(f))) return false;
    return /\.(ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|env\.example)$/.test(f);
  });
  const loadedFiles: { path: string; content: string }[] = [];
  for (const f of hexScanCandidates) {
    const abs = join(REPO_ROOT, f);
    if (!existsSync(abs)) continue;
    try {
      loadedFiles.push({ path: f, content: readFileSync(abs, "utf8") });
    } catch {
      // unreadable (binary, etc.) — skip silently
    }
  }
  results.push(checkNoHardcodedHexKeys(loadedFiles));

  return results;
}

async function runRuntimeChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(checkPhiEncryptionKey(process.env));
  results.push(checkPhiHmacKey(process.env));
  results.push(checkKillSwitchEnv(process.env));

  // DB-dependent checks — only run if DATABASE_URL is set and connection opens.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    results.push({
      ok: false,
      name: "runtime: database connection",
      reason: "DATABASE_URL is not set. Cannot verify migration state or ciphertext.",
    });
    return results;
  }

  let postgres: (url: string) => {
    unsafe: (q: string, p?: unknown) => Promise<Record<string, unknown>[]>;
    end: () => Promise<void>;
  };
  try {
    const mod = (await import("postgres")) as unknown as {
      default: typeof postgres;
    };
    postgres = mod.default;
  } catch (err) {
    results.push({
      ok: false,
      name: "runtime: database connection",
      reason: `Failed to load postgres driver: ${(err as Error).message}`,
    });
    return results;
  }

  const sql = postgres(databaseUrl);
  try {
    const sqlClient: SqlClient = {
      unsafe: (query, params) =>
        sql.unsafe(query, params as never) as unknown as Promise<
          Record<string, unknown>[]
        >,
    };
    results.push(await checkMigration0011Applied(sqlClient));
    results.push(await checkClinicalNotesSectionsEncrypted(sqlClient));
  } finally {
    await sql.end();
  }

  return results;
}

function parseMode(argv: readonly string[]): "static" | "runtime" {
  for (const arg of argv) {
    if (arg === "--mode=static") return "static";
    if (arg === "--mode=runtime") return "runtime";
  }
  console.error(
    "usage: phi-readiness-check --mode=<static|runtime>\n" +
      "  static  — repository-level invariants (runs in CI)\n" +
      "  runtime — environment + DB invariants (runs in deploy pipeline)",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  console.log(`PHI readiness gate — mode: ${mode}`);
  console.log("");

  const results =
    mode === "static" ? await runStaticChecks() : await runRuntimeChecks();

  const report = aggregate(results);
  console.log(formatReport(report));

  if (report.failed > 0) {
    console.error(
      "\nPHI readiness gate FAILED. Do not deploy until all checks pass.",
    );
    process.exit(1);
  }
  console.log("\nPHI readiness gate passed.");
}

main().catch((err) => {
  console.error("phi-readiness-check crashed:", err);
  process.exit(1);
});
