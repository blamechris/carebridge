import { describe, it, expect } from "vitest";
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
  checkPhiEncryptionKey,
  checkPhiHmacKey,
  checkReEncryptionScript,
  checkRedactorExports,
  checkSanitizationGuards,
  formatReport,
  type CheckResult,
  type SqlClient,
} from "../phi-readiness-checks.js";

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

describe("checkKillSwitchInClaudeClient", () => {
  it("passes when all required identifiers are present", () => {
    const source = `
      export const AI_OVERSIGHT_LLM_ENABLED = true;
      export const AI_OVERSIGHT_BAA_ACKNOWLEDGED = true;
      export function assertLLMEnabled() {}
      export class LLMDisabledError extends Error {}
    `;
    expect(checkKillSwitchInClaudeClient(source).ok).toBe(true);
  });

  it("fails when kill-switch env var is missing", () => {
    const source = `export function assertLLMEnabled() {} class LLMDisabledError {}`;
    const result = checkKillSwitchInClaudeClient(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/AI_OVERSIGHT_LLM_ENABLED/);
      expect(result.reason).toMatch(/AI_OVERSIGHT_BAA_ACKNOWLEDGED/);
    }
  });

  it("fails when LLMDisabledError class is removed", () => {
    const source = `AI_OVERSIGHT_LLM_ENABLED AI_OVERSIGHT_BAA_ACKNOWLEDGED assertLLMEnabled`;
    const result = checkKillSwitchInClaudeClient(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/LLMDisabledError/);
  });
});

describe("checkKillSwitchInReviewService", () => {
  it("passes when isLLMEnabled and LLMDisabledError are referenced", () => {
    const source = `if (!isLLMEnabled()) return; try {} catch (e) { if (e instanceof LLMDisabledError) {} }`;
    expect(checkKillSwitchInReviewService(source).ok).toBe(true);
  });

  it("passes when assertLLMEnabled + LLMDisabledError are referenced", () => {
    const source = `assertLLMEnabled(); try {} catch (e) { throw new LLMDisabledError("x"); }`;
    expect(checkKillSwitchInReviewService(source).ok).toBe(true);
  });

  it("fails when no gate call is present", () => {
    const source = `// review service without kill-switch LLMDisabledError`;
    const result = checkKillSwitchInReviewService(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isLLMEnabled|assertLLMEnabled/);
  });

  it("fails when defensive catch is missing", () => {
    const source = `isLLMEnabled();`; // no LLMDisabledError
    const result = checkKillSwitchInReviewService(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/LLMDisabledError/);
  });
});

describe("checkBootTimeStatusLog", () => {
  it("passes when logLLMStatus is called", () => {
    expect(checkBootTimeStatusLog("logLLMStatus();").ok).toBe(true);
  });
  it("fails when logLLMStatus is absent", () => {
    const result = checkBootTimeStatusLog("// no status log");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/logLLMStatus/);
  });
});

describe("checkRedactorExports", () => {
  it("passes when all expanded exports are present", () => {
    const source = `
      export function redactSSNs() {}
      export function redactICD10Codes() {}
      export function redactSNOMEDCodes() {}
      export const SANITIZATION_GUARDS: readonly RegExp[] = [];
    `;
    expect(checkRedactorExports(source).ok).toBe(true);
  });

  it("fails when SSN redactor is missing", () => {
    const source = `redactICD10Codes redactSNOMEDCodes SANITIZATION_GUARDS`;
    const result = checkRedactorExports(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/redactSSNs/);
  });
});

describe("checkSanitizationGuards", () => {
  it("passes when all required patterns are in SANITIZATION_GUARDS", () => {
    const source = `
      const SANITIZATION_GUARDS = [
        NAME_LAST_FIRST,
        MRN_CONTEXT,
        ICD10_DOTTED,
        SNOMED_LABELED,
      ];
    `;
    expect(checkSanitizationGuards(source).ok).toBe(true);
  });

  it("fails when ICD10_DOTTED is missing from guards", () => {
    const source = `
      const SANITIZATION_GUARDS = [ MRN_CONTEXT, SNOMED_LABELED ];
    `;
    const result = checkSanitizationGuards(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ICD10_DOTTED/);
  });

  it("fails when SANITIZATION_GUARDS cannot be located", () => {
    const result = checkSanitizationGuards("// no guards declared");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Could not locate/);
  });
});

describe("checkEnvExampleDocuments", () => {
  it("passes when all required keys are documented", () => {
    const envExample = `
      PHI_ENCRYPTION_KEY=
      PHI_HMAC_KEY=
      AI_OVERSIGHT_LLM_ENABLED=false
      AI_OVERSIGHT_BAA_ACKNOWLEDGED=false
    `;
    expect(checkEnvExampleDocuments(envExample).ok).toBe(true);
  });

  it("fails when kill-switch vars are missing", () => {
    const envExample = `PHI_ENCRYPTION_KEY=\nPHI_HMAC_KEY=`;
    const result = checkEnvExampleDocuments(envExample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/AI_OVERSIGHT_LLM_ENABLED/);
      expect(result.reason).toMatch(/AI_OVERSIGHT_BAA_ACKNOWLEDGED/);
    }
  });
});

describe("checkEnvGitignored", () => {
  it("passes when .env is on a line by itself", () => {
    expect(checkEnvGitignored(".env\n.DS_Store\nnode_modules").ok).toBe(true);
  });
  it("passes when /.env is listed", () => {
    expect(checkEnvGitignored("/.env\nnode_modules").ok).toBe(true);
  });
  it("fails when .env is absent", () => {
    const result = checkEnvGitignored("node_modules\ndist");
    expect(result.ok).toBe(false);
  });
});

describe("checkNoEnvFilesTracked", () => {
  it("passes when only .env.example is tracked", () => {
    expect(checkNoEnvFilesTracked([".env.example", "README.md"]).ok).toBe(true);
  });
  it("passes when .env.test is tracked (explicit allowlist)", () => {
    expect(checkNoEnvFilesTracked([".env.test"]).ok).toBe(true);
  });
  it("fails when a bare .env is tracked", () => {
    const result = checkNoEnvFilesTracked([".env", "src/index.ts"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/\.env/);
  });
  it("fails when .env.production is tracked", () => {
    const result = checkNoEnvFilesTracked([".env.production"]);
    expect(result.ok).toBe(false);
  });
  it("ignores nested .env.example files", () => {
    expect(
      checkNoEnvFilesTracked(["apps/web/.env.example", "README.md"]).ok,
    ).toBe(true);
  });
});

describe("checkNoHardcodedHexKeys", () => {
  it("passes for plain code with no hex keys", () => {
    const files = [
      { path: "src/a.ts", content: "export const x = 42;" },
      { path: "src/b.ts", content: "const short = 'abcdef';" },
    ];
    expect(checkNoHardcodedHexKeys(files).ok).toBe(true);
  });

  it("fails when a file contains a bare 64-hex-char token", () => {
    const hex = "a".repeat(64);
    const files = [{ path: "src/leak.ts", content: `const key = "${hex}";` }];
    const result = checkNoHardcodedHexKeys(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/src\/leak\.ts/);
  });

  it("does not match shorter hex strings (sha256 hashes are 64 but we only block bare tokens)", () => {
    // 63 chars — should NOT match
    const hex = "f".repeat(63);
    const files = [{ path: "src/a.ts", content: `const hash = "${hex}";` }];
    expect(checkNoHardcodedHexKeys(files).ok).toBe(true);
  });

  it("does not match 65-char hex strings (lookahead prevents substring matches)", () => {
    const hex = "f".repeat(65);
    const files = [{ path: "src/a.ts", content: `const x = "${hex}";` }];
    expect(checkNoHardcodedHexKeys(files).ok).toBe(true);
  });
});

describe("checkMigration0011", () => {
  it("passes when migration file references expected table transforms", () => {
    const sql = `
      ALTER TABLE "clinical_notes"
        ALTER COLUMN "sections" SET DATA TYPE text USING "sections"::text;
      ALTER TABLE "note_versions"
        ALTER COLUMN "sections" SET DATA TYPE text USING "sections"::text;
    `;
    expect(checkMigration0011(sql).ok).toBe(true);
  });

  it("fails when file is missing (null)", () => {
    const result = checkMigration0011(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not found/);
  });

  it("fails when clinical_notes transform is removed", () => {
    const sql = `ALTER TABLE "note_versions" SET DATA TYPE text;`;
    expect(checkMigration0011(sql).ok).toBe(false);
  });
});

describe("checkReEncryptionScript", () => {
  it("passes when all required identifiers are present", () => {
    const src = `
      export const MIGRATION_0011_TARGETS = [];
      export const ENCRYPTED_PATTERN = /./;
      export async function runMigration() {}
    `;
    expect(checkReEncryptionScript(src).ok).toBe(true);
  });
  it("fails when script is missing", () => {
    expect(checkReEncryptionScript(null).ok).toBe(false);
  });
  it("fails when runMigration entrypoint is removed", () => {
    const src = `MIGRATION_0011_TARGETS ENCRYPTED_PATTERN`;
    const result = checkReEncryptionScript(src);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/runMigration/);
  });
});

// ---------------------------------------------------------------------------
// Runtime env checks
// ---------------------------------------------------------------------------

describe("checkPhiEncryptionKey", () => {
  it("passes on a valid 64-hex key", () => {
    const env = { PHI_ENCRYPTION_KEY: "a".repeat(64) } as NodeJS.ProcessEnv;
    expect(checkPhiEncryptionKey(env).ok).toBe(true);
  });
  it("fails when unset", () => {
    expect(checkPhiEncryptionKey({}).ok).toBe(false);
  });
  it("fails on wrong length", () => {
    const env = { PHI_ENCRYPTION_KEY: "abcdef" } as NodeJS.ProcessEnv;
    expect(checkPhiEncryptionKey(env).ok).toBe(false);
  });
  it("fails on non-hex chars", () => {
    const env = { PHI_ENCRYPTION_KEY: "z".repeat(64) } as NodeJS.ProcessEnv;
    expect(checkPhiEncryptionKey(env).ok).toBe(false);
  });
});

describe("checkPhiHmacKey", () => {
  it("fails in production when unset", () => {
    const env = {
      NODE_ENV: "production",
      PHI_ENCRYPTION_KEY: "a".repeat(64),
    } as NodeJS.ProcessEnv;
    expect(checkPhiHmacKey(env).ok).toBe(false);
  });
  it("passes in dev when unset (informational)", () => {
    const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
    expect(checkPhiHmacKey(env).ok).toBe(true);
  });
  it("fails when HMAC key equals encryption key (key reuse)", () => {
    const same = "a".repeat(64);
    const env = {
      NODE_ENV: "production",
      PHI_ENCRYPTION_KEY: same,
      PHI_HMAC_KEY: same,
    } as NodeJS.ProcessEnv;
    const result = checkPhiHmacKey(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must NOT equal/);
  });
  it("passes in production with distinct keys", () => {
    const env = {
      NODE_ENV: "production",
      PHI_ENCRYPTION_KEY: "a".repeat(64),
      PHI_HMAC_KEY: "b".repeat(64),
    } as NodeJS.ProcessEnv;
    expect(checkPhiHmacKey(env).ok).toBe(true);
  });
});

describe("checkKillSwitchEnv", () => {
  it("fails when LLM_ENABLED is unset", () => {
    expect(checkKillSwitchEnv({}).ok).toBe(false);
  });
  it("fails when LLM_ENABLED is not 'true' or 'false'", () => {
    const env = {
      AI_OVERSIGHT_LLM_ENABLED: "1",
      AI_OVERSIGHT_BAA_ACKNOWLEDGED: "true",
    } as NodeJS.ProcessEnv;
    const result = checkKillSwitchEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must be 'true' or 'false'/);
  });
  it("fails when BAA is unset", () => {
    const env = {
      AI_OVERSIGHT_LLM_ENABLED: "false",
    } as NodeJS.ProcessEnv;
    expect(checkKillSwitchEnv(env).ok).toBe(false);
  });
  it("fails when LLM_ENABLED=true but BAA!=true", () => {
    const env = {
      AI_OVERSIGHT_LLM_ENABLED: "true",
      AI_OVERSIGHT_BAA_ACKNOWLEDGED: "false",
    } as NodeJS.ProcessEnv;
    const result = checkKillSwitchEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/BAA prerequisite/);
  });
  it("fails when LLM_ENABLED=true but ANTHROPIC_API_KEY missing", () => {
    const env = {
      AI_OVERSIGHT_LLM_ENABLED: "true",
      AI_OVERSIGHT_BAA_ACKNOWLEDGED: "true",
    } as NodeJS.ProcessEnv;
    const result = checkKillSwitchEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ANTHROPIC_API_KEY/);
  });
  it("passes when both flags are 'false'", () => {
    const env = {
      AI_OVERSIGHT_LLM_ENABLED: "false",
      AI_OVERSIGHT_BAA_ACKNOWLEDGED: "false",
    } as NodeJS.ProcessEnv;
    const result = checkKillSwitchEnv(env);
    expect(result.ok).toBe(true);
  });
  it("passes when both flags are 'true' and ANTHROPIC_API_KEY is set", () => {
    const env = {
      AI_OVERSIGHT_LLM_ENABLED: "true",
      AI_OVERSIGHT_BAA_ACKNOWLEDGED: "true",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    } as NodeJS.ProcessEnv;
    expect(checkKillSwitchEnv(env).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runtime DB checks (fake sql client)
// ---------------------------------------------------------------------------

function fakeSql(
  handler: (query: string, params?: unknown[]) => Record<string, unknown>[],
): SqlClient {
  return {
    unsafe: async (q, p) => handler(q, p),
  };
}

describe("checkMigration0011Applied", () => {
  it("passes when drizzle journal contains 0011", async () => {
    const sql = fakeSql(() => [{ hash: "0011_encrypt_clinical_narratives" }]);
    const result = await checkMigration0011Applied(sql);
    expect(result.ok).toBe(true);
  });

  it("fails when drizzle journal is empty", async () => {
    const sql = fakeSql(() => []);
    const result = await checkMigration0011Applied(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/pnpm db:migrate/);
  });

  it("fails when query throws (e.g., schema missing)", async () => {
    const sql: SqlClient = {
      unsafe: async () => {
        throw new Error("relation drizzle.__drizzle_migrations does not exist");
      },
    };
    const result = await checkMigration0011Applied(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/relation/);
  });
});

describe("checkClinicalNotesSectionsEncrypted", () => {
  const CIPHERTEXT =
    "a".repeat(32) + ":" + "b".repeat(32) + ":" + "0123456789abcdef";

  it("passes when the table is empty", async () => {
    const sql = fakeSql(() => []);
    const result = await checkClinicalNotesSectionsEncrypted(sql);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toMatch(/empty/);
  });

  it("passes when all sampled rows contain ciphertext", async () => {
    const sql = fakeSql(() => [
      { id: "n1", sections: CIPHERTEXT },
      { id: "n2", sections: CIPHERTEXT },
    ]);
    const result = await checkClinicalNotesSectionsEncrypted(sql);
    expect(result.ok).toBe(true);
  });

  it("fails when a row still holds plaintext JSON", async () => {
    const sql = fakeSql(() => [
      { id: "n1", sections: CIPHERTEXT },
      { id: "n2", sections: '[{"type":"SOAP","body":"plaintext leaked"}]' },
    ]);
    const result = await checkClinicalNotesSectionsEncrypted(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/n2/);
      expect(result.reason).toMatch(/encrypt:0011/);
    }
  });

  it("fails when sections is non-string (null)", async () => {
    const sql = fakeSql(() => [{ id: "n1", sections: null }]);
    const result = await checkClinicalNotesSectionsEncrypted(sql);
    expect(result.ok).toBe(false);
  });

  it("does not leak plaintext values in error output", async () => {
    const sql = fakeSql(() => [
      {
        id: "n1",
        sections: '{"phi":"John Doe DOB 1960-01-01 MRN 12345"}',
      },
    ]);
    const result = await checkClinicalNotesSectionsEncrypted(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toMatch(/John Doe/);
      expect(result.reason).not.toMatch(/MRN/);
      expect(result.reason).not.toMatch(/1960/);
    }
  });
});

// ---------------------------------------------------------------------------
// Aggregation / formatting
// ---------------------------------------------------------------------------

describe("aggregate / formatReport", () => {
  it("counts passes and failures", () => {
    const results: CheckResult[] = [
      { ok: true, name: "a" },
      { ok: false, name: "b", reason: "bad" },
      { ok: true, name: "c", detail: "with detail" },
    ];
    const report = aggregate(results);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
  });

  it("formats the report with OK/FAIL markers", () => {
    const report = aggregate([
      { ok: true, name: "kill-switch: claude-client" },
      { ok: false, name: "migration: 0011 present", reason: "missing" },
    ]);
    const out = formatReport(report);
    expect(out).toMatch(/OK   kill-switch: claude-client/);
    expect(out).toMatch(/FAIL migration: 0011 present/);
    expect(out).toMatch(/→ missing/);
    expect(out).toMatch(/1 passed, 1 failed/);
  });
});
