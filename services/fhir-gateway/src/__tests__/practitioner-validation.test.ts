import { describe, it, expect } from "vitest";
import {
  isValidNpi,
  isValidNuccCode,
} from "../generators/practitioner-validation.js";
import {
  toFhirPractitioner,
  US_NPI_IDENTIFIER_SYSTEM,
  NUCC_TAXONOMY_SYSTEM,
} from "../generators/practitioner.js";
import { CAREBRIDGE_IDENTIFIER_BASE } from "../generators/identifiers.js";

// Shared user factory for generator-side conformance assertions below.
type User = Parameters<typeof toFhirPractitioner>[0];
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "dr.jones@carebridge.dev",
    password_hash: "hash",
    name: "Sarah Jones",
    role: "physician",
    patient_id: null,
    specialty: "Oncology",
    department: "Hem-Onc",
    is_active: true,
    mfa_secret: null,
    mfa_enabled: false,
    recovery_codes: null,
    npi: null,
    nucc_code: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as User;
}

describe("isValidNpi (#1150 — CMS NPI check-digit / modified Luhn)", () => {
  it("accepts a known-good 10-digit NPI with correct check digit", () => {
    // 1234567893: classic textbook example for the CMS NPI Luhn algorithm.
    // Verified manually: prefix '80840' + first 9 digits '123456789',
    // double every second digit from the right, sum digits, mod 10 = 0
    // implies check digit '3'.
    expect(isValidNpi("1234567893")).toBe(true);
  });

  it("rejects an NPI that is 10 digits but fails the Luhn check", () => {
    // 1234567890 — same first 9 digits as the valid case, wrong check.
    expect(isValidNpi("1234567890")).toBe(false);
  });

  it("rejects an NPI that is too short", () => {
    expect(isValidNpi("123456789")).toBe(false);
    expect(isValidNpi("")).toBe(false);
  });

  it("rejects an NPI that is too long", () => {
    expect(isValidNpi("12345678931")).toBe(false);
  });

  it("rejects an NPI containing non-digit characters", () => {
    expect(isValidNpi("12345A7893")).toBe(false);
    expect(isValidNpi("123-456-789")).toBe(false);
    expect(isValidNpi(" 1234567893 ")).toBe(false);
  });

  it("rejects the all-zeros placeholder", () => {
    // All zeros has a valid Luhn checksum (0), but is not a real NPI.
    // It also typically indicates a placeholder / unfilled value.
    // Sentinel guard so backfills don't slip through.
    expect(isValidNpi("0000000000")).toBe(false);
  });
});

describe("isValidNuccCode (#1150 — NUCC taxonomy shape)", () => {
  it("accepts canonical NUCC codes following XXXXX0000X pattern", () => {
    // 207RC0000X — Cardiologist, Clinical Cardiac Electrophysiology.
    expect(isValidNuccCode("207RC0000X")).toBe(true);
    // 208000000X — Pediatric Surgery.
    expect(isValidNuccCode("208000000X")).toBe(true);
  });

  it("rejects lowercase input (canonical NUCC is uppercase, DB CHECK is case-sensitive)", () => {
    // Downstream FHIR validators (Inferno, Touchstone, HAPI) compare
    // exact case against the registered NUCC code system. The DB CHECK
    // constraint also enforces uppercase via `~ '^[A-Z0-9]{5}0000[A-Z]$'`.
    // Accepting lowercase here would create an app/DB asymmetry and
    // risk a false `meta.profile = us-core-practitioner` claim if a
    // lowercase value ever reached the generator.
    expect(isValidNuccCode("207rc0000x")).toBe(false);
    expect(isValidNuccCode("207RC0000x")).toBe(false); // mixed case
    expect(isValidNuccCode("207rC0000X")).toBe(false); // mixed case
  });

  it("rejects a code that is too short", () => {
    expect(isValidNuccCode("207RC0000")).toBe(false);
    expect(isValidNuccCode("")).toBe(false);
  });

  it("rejects a code that is too long", () => {
    expect(isValidNuccCode("207RC0000XX")).toBe(false);
  });

  it("rejects a code missing the literal '0000' segment", () => {
    expect(isValidNuccCode("207RC1234X")).toBe(false);
    expect(isValidNuccCode("207RC0001X")).toBe(false);
  });

  it("rejects a code with a non-letter terminal char", () => {
    expect(isValidNuccCode("207RC00001")).toBe(false);
    expect(isValidNuccCode("207RC0000-")).toBe(false);
  });

  it("rejects a code containing disallowed characters in the prefix", () => {
    expect(isValidNuccCode("207-C0000X")).toBe(false);
    expect(isValidNuccCode("207 C0000X")).toBe(false);
  });
});

describe("toFhirPractitioner conformance gate honours shape validators (#1150)", () => {
  const VALID_NPI = "1234567893";
  const VALID_NUCC = "207RC0000X";

  it("omits the NPI identifier when the NPI value fails Luhn validation", () => {
    const p = toFhirPractitioner(
      makeUser({
        id: "prov-bad-npi",
        npi: "1234567890", // 10 digits but wrong Luhn check
        nucc_code: VALID_NUCC,
        specialty: "Clinical Cardiac Electrophysiology",
      }),
    );
    // No us-npi identifier entry should be present.
    const hasNpiId = p.identifier?.some(
      (id) => id.system === US_NPI_IDENTIFIER_SYSTEM,
    );
    expect(hasNpiId).toBe(false);
    // Internal identifier still present for local lookups.
    expect(p.identifier?.[0]?.system).toBe(
      `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
    );
    expect(p.identifier?.[0]?.value).toBe("prov-bad-npi");
    // Conformance claim must NOT be emitted — false claim risk.
    expect(p.meta).toBeUndefined();
  });

  it("omits the NUCC qualification coding when the NUCC value is malformed", () => {
    const p = toFhirPractitioner(
      makeUser({
        npi: VALID_NPI,
        nucc_code: "BADNUCC",
        specialty: "Oncology",
      }),
    );
    // Qualification.text still present (it's free-text specialty),
    // but no coding[] entry because the shape failed.
    expect(p.qualification?.[0]?.code?.text).toBe("Oncology");
    expect(p.qualification?.[0]?.code?.coding).toBeUndefined();
    // No conformance claim — gate requires VALID NUCC.
    expect(p.meta).toBeUndefined();
  });

  it("emits full meta.profile conformance claim ONLY when both NPI and NUCC are shape-valid", () => {
    const p = toFhirPractitioner(
      makeUser({
        npi: VALID_NPI,
        nucc_code: VALID_NUCC,
        specialty: "Clinical Cardiac Electrophysiology",
      }),
    );
    expect(p.meta?.profile).toEqual([
      "http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner",
    ]);
    // NPI identifier present.
    expect(p.identifier?.[0]?.system).toBe(US_NPI_IDENTIFIER_SYSTEM);
    expect(p.identifier?.[0]?.value).toBe(VALID_NPI);
    // NUCC coding present.
    expect(p.qualification?.[0]?.code?.coding?.[0]).toEqual({
      system: NUCC_TAXONOMY_SYSTEM,
      code: VALID_NUCC,
    });
  });

  it("malformed NPI + malformed NUCC: both invalid, neither emitted, no profile claim", () => {
    const p = toFhirPractitioner(
      makeUser({
        id: "prov-bad-both",
        npi: "abcdefghij",
        nucc_code: "????",
        specialty: "Oncology",
      }),
    );
    expect(p.meta).toBeUndefined();
    expect(p.identifier).toHaveLength(1);
    expect(p.identifier?.[0]?.system).toBe(
      `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
    );
    expect(p.qualification?.[0]?.code?.text).toBe("Oncology");
    expect(p.qualification?.[0]?.code?.coding).toBeUndefined();
  });
});
