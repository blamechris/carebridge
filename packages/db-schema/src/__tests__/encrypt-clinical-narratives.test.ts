import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ENCRYPTED_PATTERN,
  MIGRATION_0011_TARGETS,
  classifyValue,
  runMigration,
  type RunOptions,
} from "../encrypt-clinical-narratives.js";
import { encrypt, decrypt } from "../encryption.js";

const TEST_KEY = randomBytes(32).toString("hex");

beforeAll(() => {
  process.env.PHI_ENCRYPTION_KEY = TEST_KEY;
});

describe("ENCRYPTED_PATTERN", () => {
  it("matches the wire format produced by encrypt()", () => {
    const sample = encrypt("hello", TEST_KEY);
    expect(ENCRYPTED_PATTERN.test(sample)).toBe(true);
  });

  it("rejects plaintext", () => {
    expect(ENCRYPTED_PATTERN.test("patient has diabetes")).toBe(false);
    expect(ENCRYPTED_PATTERN.test("12345")).toBe(false);
    expect(ENCRYPTED_PATTERN.test("")).toBe(false);
  });

  it("rejects near-matches (wrong iv length, wrong separator count)", () => {
    // Only one colon
    expect(ENCRYPTED_PATTERN.test("aabbcc:ddeeff")).toBe(false);
    // Three colons but iv/auth are not 32 hex chars
    expect(ENCRYPTED_PATTERN.test("abc:def:ghi")).toBe(false);
    // Correct structure but non-hex payload
    expect(
      ENCRYPTED_PATTERN.test(
        "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz:zz",
      ),
    ).toBe(false);
  });

  it("rejects JSON that happens to contain colons", () => {
    expect(
      ENCRYPTED_PATTERN.test('{"template":"SOAP","sections":[]}'),
    ).toBe(false);
  });
});

describe("classifyValue", () => {
  it("returns null for null / undefined / non-strings", () => {
    expect(classifyValue(null, "text")).toEqual({ kind: "null" });
    expect(classifyValue(undefined, "text")).toEqual({ kind: "null" });
    expect(classifyValue(123, "text")).toEqual({ kind: "null" });
    expect(classifyValue({}, "text")).toEqual({ kind: "null" });
  });

  it("returns already-encrypted for values that match the wire format", () => {
    const ct = encrypt("protected", TEST_KEY);
    expect(classifyValue(ct, "text")).toEqual({ kind: "already-encrypted" });
  });

  it("returns plaintext for plain text values", () => {
    const result = classifyValue("Stage IV lung adenocarcinoma", "text");
    expect(result).toEqual({
      kind: "plaintext",
      value: "Stage IV lung adenocarcinoma",
    });
  });

  it("accepts valid JSON for json-kind columns", () => {
    const result = classifyValue('[{"type":"SOAP","body":"x"}]', "json");
    expect(result.kind).toBe("plaintext");
  });

  it("flags invalid JSON for json-kind columns", () => {
    const result = classifyValue("not-json-at-all", "json");
    expect(result.kind).toBe("invalid-json");
  });

  it("short-circuits already-encrypted check before JSON parse for json columns", () => {
    // An encrypted blob is not valid JSON, but the idempotency check must run
    // FIRST so re-runs don't misclassify previously-encrypted rows as corrupt.
    const ct = encrypt('[{"type":"SOAP"}]', TEST_KEY);
    expect(classifyValue(ct, "json")).toEqual({ kind: "already-encrypted" });
  });
});

describe("MIGRATION_0011_TARGETS", () => {
  it("covers every column mentioned in the migration SQL file", () => {
    // These are the columns the 0011 migration converted to encryptedText /
    // encryptedJsonb. Keep in sync with drizzle/0011_encrypt_clinical_narratives.sql.
    const expected: Record<string, string[]> = {
      diagnoses: ["description"],
      allergies: ["allergen", "reaction"],
      medications: ["name", "brand_name", "notes"],
      vitals: ["notes"],
      lab_results: ["notes"],
      procedures: ["notes"],
      clinical_notes: ["sections"],
      note_versions: ["sections"],
    };

    const actual: Record<string, string[]> = {};
    for (const t of MIGRATION_0011_TARGETS) {
      actual[t.table] = [...t.columns];
    }
    expect(actual).toEqual(expected);
  });

  it("marks sections columns as json kind and the rest as text", () => {
    for (const t of MIGRATION_0011_TARGETS) {
      if (t.table === "clinical_notes" || t.table === "note_versions") {
        expect(t.kind).toBe("json");
      } else {
        expect(t.kind).toBe("text");
      }
    }
  });
});

/**
 * Minimal in-memory mock of the postgres.js template-tag client. Only
 * implements the .unsafe() method and .end() — runMigration() uses .unsafe()
 * exclusively because the SQL it builds has dynamic identifiers (table and
 * column names) that can't be safely composed with the template tag.
 */
interface MockRow {
  id: string;
  [col: string]: unknown;
}

function createMockSql(tables: Record<string, MockRow[]>) {
  const queries: string[] = [];

  async function unsafe(query: string, params: unknown[] = []) {
    queries.push(query);

    const selectMatch = query.match(
      /SELECT\s+(.+?)\s+FROM\s+"([^"]+)"\s*(?:WHERE\s+"id"\s*>\s*\$1)?\s*ORDER BY\s+"id"\s+LIMIT\s+(\d+)/i,
    );
    if (selectMatch) {
      const columnsCsv = selectMatch[1];
      const table = selectMatch[2];
      const limit = Number.parseInt(selectMatch[3], 10);
      const afterId = params[0] as string | undefined;

      const selectedCols = columnsCsv
        .split(",")
        .map((c) => c.trim().replace(/"/g, ""));

      const rows = tables[table] ?? [];
      const sorted = [...rows].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      const filtered = afterId
        ? sorted.filter((r) => r.id > afterId)
        : sorted;
      const page = filtered.slice(0, limit);

      return page.map((r) => {
        const projected: Record<string, unknown> = {};
        for (const col of selectedCols) {
          projected[col] = r[col];
        }
        return projected;
      });
    }

    const updateMatch = query.match(
      /UPDATE\s+"([^"]+)"\s+SET\s+(.+?)\s+WHERE\s+"id"\s*=\s*\$1/i,
    );
    if (updateMatch) {
      const table = updateMatch[1];
      const setClause = updateMatch[2];
      const id = params[0] as string;
      const setValues = params.slice(1);

      const setCols = setClause
        .split(",")
        .map((s) => s.trim().match(/"([^"]+)"\s*=/)?.[1])
        .filter((x): x is string => typeof x === "string");

      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (row) {
        setCols.forEach((col, i) => {
          row[col] = setValues[i];
        });
      }
      return [];
    }

    return [];
  }

  return {
    unsafe,
    end: async () => {},
    queries,
  };
}

describe("runMigration end-to-end (mocked sql)", () => {
  const BASE_OPTIONS: RunOptions = {
    dryRun: false,
    batchSize: 10,
    tableFilter: null,
  };

  it("encrypts plaintext values across all target tables", async () => {
    const tables: Record<string, MockRow[]> = {
      diagnoses: [
        { id: "d1", description: "Type 2 diabetes" },
        { id: "d2", description: "Hypertension" },
      ],
      allergies: [
        { id: "a1", allergen: "penicillin", reaction: "hives" },
        { id: "a2", allergen: "peanuts", reaction: null },
      ],
      medications: [
        { id: "m1", name: "metformin", brand_name: "Glucophage", notes: null },
      ],
      vitals: [{ id: "v1", notes: "pt reports dizziness" }],
      lab_results: [{ id: "l1", notes: null }],
      procedures: [{ id: "p1", notes: "uneventful" }],
      clinical_notes: [
        { id: "n1", sections: '[{"type":"SOAP","body":"subjective"}]' },
      ],
      note_versions: [
        { id: "nv1", sections: '[{"type":"SOAP","body":"v1"}]' },
      ],
    };

    const mock = createMockSql(tables);
    const report = await runMigration(mock as never, BASE_OPTIONS, TEST_KEY);

    expect(report.totalErrors).toBe(0);

    // Verify that all originally plaintext values are now encrypted AND that
    // decrypting them returns the original plaintext.
    expect(ENCRYPTED_PATTERN.test(tables.diagnoses[0].description as string)).toBe(true);
    expect(decrypt(tables.diagnoses[0].description as string, TEST_KEY)).toBe(
      "Type 2 diabetes",
    );
    expect(decrypt(tables.allergies[0].allergen as string, TEST_KEY)).toBe(
      "penicillin",
    );
    expect(decrypt(tables.allergies[0].reaction as string, TEST_KEY)).toBe("hives");
    // Null reaction stays null.
    expect(tables.allergies[1].reaction).toBeNull();
    expect(decrypt(tables.medications[0].name as string, TEST_KEY)).toBe("metformin");
    expect(decrypt(tables.medications[0].brand_name as string, TEST_KEY)).toBe(
      "Glucophage",
    );
    // Null notes stays null.
    expect(tables.medications[0].notes).toBeNull();

    // JSON columns: decrypt then JSON.parse should match the original object.
    const notesSectionsCt = tables.clinical_notes[0].sections as string;
    expect(ENCRYPTED_PATTERN.test(notesSectionsCt)).toBe(true);
    expect(JSON.parse(decrypt(notesSectionsCt, TEST_KEY))).toEqual([
      { type: "SOAP", body: "subjective" },
    ]);
  });

  it("is idempotent — re-running touches nothing", async () => {
    const tables: Record<string, MockRow[]> = {
      diagnoses: [{ id: "d1", description: "asthma" }],
      allergies: [],
      medications: [],
      vitals: [],
      lab_results: [],
      procedures: [],
      clinical_notes: [],
      note_versions: [],
    };

    // First pass encrypts.
    await runMigration(createMockSql(tables) as never, BASE_OPTIONS, TEST_KEY);
    const ctAfterFirst = tables.diagnoses[0].description;

    // Second pass should skip (value already matches ENCRYPTED_PATTERN).
    const report2 = await runMigration(
      createMockSql(tables) as never,
      BASE_OPTIONS,
      TEST_KEY,
    );
    const diagnosesReport = report2.tables.find((t) => t.table === "diagnoses")!;
    expect(diagnosesReport.valuesEncrypted).toBe(0);
    expect(diagnosesReport.valuesSkipped).toBe(1);

    // Value is untouched between runs.
    expect(tables.diagnoses[0].description).toBe(ctAfterFirst);
  });

  it("dry-run does not mutate rows", async () => {
    const tables: Record<string, MockRow[]> = {
      diagnoses: [{ id: "d1", description: "migraine" }],
      allergies: [],
      medications: [],
      vitals: [],
      lab_results: [],
      procedures: [],
      clinical_notes: [],
      note_versions: [],
    };

    const report = await runMigration(
      createMockSql(tables) as never,
      { ...BASE_OPTIONS, dryRun: true },
      TEST_KEY,
    );

    expect(tables.diagnoses[0].description).toBe("migraine");
    const diagnosesReport = report.tables.find((t) => t.table === "diagnoses")!;
    // Dry-run still counts values it WOULD have encrypted.
    expect(diagnosesReport.valuesEncrypted).toBe(1);
    expect(diagnosesReport.rowsUpdated).toBe(1);
  });

  it("flags corrupt JSON in json-kind columns without encrypting them", async () => {
    const tables: Record<string, MockRow[]> = {
      diagnoses: [],
      allergies: [],
      medications: [],
      vitals: [],
      lab_results: [],
      procedures: [],
      clinical_notes: [{ id: "n1", sections: "not-json-at-all" }],
      note_versions: [],
    };

    const report = await runMigration(
      createMockSql(tables) as never,
      BASE_OPTIONS,
      TEST_KEY,
    );

    expect(report.totalErrors).toBe(1);
    // Value must NOT have been encrypted — operator needs to investigate.
    expect(tables.clinical_notes[0].sections).toBe("not-json-at-all");
  });

  it("paginates across batches correctly", async () => {
    // 25 rows, batch size 10 → 3 batches.
    const rows: MockRow[] = Array.from({ length: 25 }, (_, i) => ({
      id: `id-${i.toString().padStart(3, "0")}`,
      description: `diagnosis #${i}`,
    }));

    const tables: Record<string, MockRow[]> = {
      diagnoses: rows,
      allergies: [],
      medications: [],
      vitals: [],
      lab_results: [],
      procedures: [],
      clinical_notes: [],
      note_versions: [],
    };

    const report = await runMigration(
      createMockSql(tables) as never,
      { ...BASE_OPTIONS, batchSize: 10 },
      TEST_KEY,
    );

    const diagnosesReport = report.tables.find((t) => t.table === "diagnoses")!;
    expect(diagnosesReport.rowsScanned).toBe(25);
    expect(diagnosesReport.valuesEncrypted).toBe(25);

    // Every row decrypts back to its original value.
    for (let i = 0; i < 25; i++) {
      expect(decrypt(rows[i].description as string, TEST_KEY)).toBe(
        `diagnosis #${i}`,
      );
    }
  });

  it("respects tableFilter", async () => {
    const tables: Record<string, MockRow[]> = {
      diagnoses: [{ id: "d1", description: "covered" }],
      allergies: [{ id: "a1", allergen: "penicillin", reaction: null }],
      medications: [],
      vitals: [],
      lab_results: [],
      procedures: [],
      clinical_notes: [],
      note_versions: [],
    };

    const report = await runMigration(
      createMockSql(tables) as never,
      { ...BASE_OPTIONS, tableFilter: ["diagnoses"] },
      TEST_KEY,
    );

    expect(report.tables.map((t) => t.table)).toEqual(["diagnoses"]);
    // Diagnoses row was encrypted.
    expect(ENCRYPTED_PATTERN.test(tables.diagnoses[0].description as string)).toBe(
      true,
    );
    // Allergies row was untouched.
    expect(tables.allergies[0].allergen).toBe("penicillin");
  });

  it("throws on unknown table in filter", async () => {
    const mock = createMockSql({});
    await expect(
      runMigration(
        mock as never,
        { ...BASE_OPTIONS, tableFilter: ["bogus_table"] },
        TEST_KEY,
      ),
    ).rejects.toThrow(/Unknown --table value/);
  });

  it("handles a mix of already-encrypted, plaintext, and null values in one table", async () => {
    const preEncrypted = encrypt("already safe", TEST_KEY);
    const tables: Record<string, MockRow[]> = {
      diagnoses: [
        { id: "d1", description: preEncrypted },
        { id: "d2", description: "needs encryption" },
        { id: "d3", description: null },
      ],
      allergies: [],
      medications: [],
      vitals: [],
      lab_results: [],
      procedures: [],
      clinical_notes: [],
      note_versions: [],
    };

    const report = await runMigration(
      createMockSql(tables) as never,
      BASE_OPTIONS,
      TEST_KEY,
    );

    const diagnosesReport = report.tables.find((t) => t.table === "diagnoses")!;
    expect(diagnosesReport.rowsScanned).toBe(3);
    expect(diagnosesReport.valuesEncrypted).toBe(1);
    expect(diagnosesReport.valuesSkipped).toBe(1);
    expect(diagnosesReport.rowsUpdated).toBe(1);

    // Original ciphertext untouched.
    expect(tables.diagnoses[0].description).toBe(preEncrypted);
    // Second row now encrypted.
    expect(decrypt(tables.diagnoses[1].description as string, TEST_KEY)).toBe(
      "needs encryption",
    );
    // Null stays null.
    expect(tables.diagnoses[2].description).toBeNull();
  });
});
