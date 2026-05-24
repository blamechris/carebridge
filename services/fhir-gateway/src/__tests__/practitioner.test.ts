import { describe, it, expect } from "vitest";
import {
  toFhirPractitioner,
  isClinicalRole,
  US_NPI_IDENTIFIER_SYSTEM,
  NUCC_TAXONOMY_SYSTEM,
} from "../generators/practitioner.js";
import { CAREBRIDGE_IDENTIFIER_BASE } from "../generators/identifiers.js";
import { US_CORE_PRACTITIONER } from "../generators/us-core-profiles.js";

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

describe("isClinicalRole", () => {
  it("accepts physician, specialist, nurse", () => {
    expect(isClinicalRole("physician")).toBe(true);
    expect(isClinicalRole("specialist")).toBe(true);
    expect(isClinicalRole("nurse")).toBe(true);
  });

  it("rejects non-clinical roles", () => {
    expect(isClinicalRole("patient")).toBe(false);
    expect(isClinicalRole("admin")).toBe(false);
    expect(isClinicalRole("family_caregiver")).toBe(false);
  });
});

describe("toFhirPractitioner (#388)", () => {
  it("uses user.id as resource id and internal identifier", () => {
    const p = toFhirPractitioner(makeUser({ id: "prov-123" }));
    expect(p.resourceType).toBe("Practitioner");
    expect(p.id).toBe("prov-123");
    expect(p.identifier?.[0]?.system).toBe(
      `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
    );
    expect(p.identifier?.[0]?.value).toBe("prov-123");
  });

  it("parses 'First Last' into family + given", () => {
    const p = toFhirPractitioner(makeUser({ name: "Sarah Jones" }));
    const n = p.name?.[0];
    expect(n?.family).toBe("Jones");
    expect(n?.given).toEqual(["Sarah"]);
    expect(n?.text).toBe("Sarah Jones");
  });

  it("parses 'First Middle Last' into given[First, Middle] + family=Last", () => {
    const p = toFhirPractitioner(makeUser({ name: "Sarah M. Jones" }));
    expect(p.name?.[0]?.given).toEqual(["Sarah", "M."]);
    expect(p.name?.[0]?.family).toBe("Jones");
  });

  it("strips trailing credentials after the first comma", () => {
    const p = toFhirPractitioner(makeUser({ name: "Sarah Jones, MD" }));
    expect(p.name?.[0]?.family).toBe("Jones");
    expect(p.name?.[0]?.given).toEqual(["Sarah"]);
    expect(p.name?.[0]?.text).toBe("Sarah Jones, MD"); // full original preserved
  });

  it("handles single-token names (family only, no given)", () => {
    const p = toFhirPractitioner(makeUser({ name: "Plato" }));
    expect(p.name?.[0]?.family).toBe("Plato");
    expect(p.name?.[0]?.given).toBeUndefined();
  });

  it("emits specialty as a text-only qualification coding when present", () => {
    const p = toFhirPractitioner(makeUser({ specialty: "Oncology" }));
    expect(p.qualification?.[0]?.code?.text).toBe("Oncology");
    // We intentionally avoid a NUCC coded value without structured input.
    expect(p.qualification?.[0]?.code?.coding).toBeUndefined();
  });

  it("omits qualification entirely when specialty is null", () => {
    const p = toFhirPractitioner(makeUser({ specialty: null }));
    expect(p.qualification).toBeUndefined();
  });

  it("Hispanic two-part surname: 'María García López' → family='García López' (#944)", () => {
    const p = toFhirPractitioner(makeUser({ name: "María García López" }));
    expect(p.name?.[0]?.family).toBe("García López");
    expect(p.name?.[0]?.given).toEqual(["María"]);
  });

  it("particle-prefixed family: 'Sarah de Klerk' → family='de Klerk' (#944)", () => {
    const p = toFhirPractitioner(makeUser({ name: "Sarah de Klerk" }));
    expect(p.name?.[0]?.family).toBe("de Klerk");
    expect(p.name?.[0]?.given).toEqual(["Sarah"]);
  });

  it("van particle: 'Jan van der Berg' → family='van der Berg' (#944)", () => {
    const p = toFhirPractitioner(makeUser({ name: "Jan van der Berg" }));
    expect(p.name?.[0]?.family).toBe("van der Berg");
    expect(p.name?.[0]?.given).toEqual(["Jan"]);
  });

  it("bin particle: 'Omar bin Hassan' → family='bin Hassan' (#944)", () => {
    const p = toFhirPractitioner(makeUser({ name: "Omar bin Hassan" }));
    expect(p.name?.[0]?.family).toBe("bin Hassan");
    expect(p.name?.[0]?.given).toEqual(["Omar"]);
  });

  it("hyphenated surname stays as one token: 'Sarah Smith-Jones' → family='Smith-Jones'", () => {
    const p = toFhirPractitioner(makeUser({ name: "Sarah Smith-Jones" }));
    expect(p.name?.[0]?.family).toBe("Smith-Jones");
    expect(p.name?.[0]?.given).toEqual(["Sarah"]);
  });

  it("middle initial preserves Anglo parse: 'Sarah M. Jones' → family='Jones'", () => {
    const p = toFhirPractitioner(makeUser({ name: "Sarah M. Jones" }));
    expect(p.name?.[0]?.family).toBe("Jones");
    expect(p.name?.[0]?.given).toEqual(["Sarah", "M."]);
  });

  it("spelled-out Anglo middle name: 'Sarah Marie Jones' → family='Marie Jones' (#974 known tradeoff)", () => {
    // Pinning test for the documented tradeoff: with no bare-initial
    // signal, the penultimate token is treated as the first half of a
    // two-part family. See parseName docstring. Long-term fix is the
    // structured name_family / name_given[] columns tracked in #972 —
    // until then, this test prevents silent behaviour flips on either
    // side of the Anglo/Hispanic split.
    const p = toFhirPractitioner(makeUser({ name: "Sarah Marie Jones" }));
    expect(p.name?.[0]?.family).toBe("Marie Jones");
    expect(p.name?.[0]?.given).toEqual(["Sarah"]);
  });

  it("4-token Anglo full middle name: 'John Robert Quincy Adams' → family='Quincy Adams' (#1027)", () => {
    // The Anglo-middle-name tradeoff isn't bounded to 3 tokens. With any
    // 3+-token name and a non-initial penultimate, family absorbs the
    // penultimate. Pinning a 4-token case so a future edit doesn't
    // silently change behaviour for longer chains.
    const p = toFhirPractitioner(makeUser({ name: "John Robert Quincy Adams" }));
    expect(p.name?.[0]?.family).toBe("Quincy Adams");
    expect(p.name?.[0]?.given).toEqual(["John", "Robert"]);
  });

  describe("structured name columns take precedence over parseName heuristic (#972)", () => {
    it("name_family + name_given populate HumanName exactly, bypassing parseName", () => {
      // Free-text "Sarah Marie Jones" would heuristic to family="Marie Jones".
      // When the structured columns are populated, they win — Marie is the
      // middle given name as the writer recorded.
      const p = toFhirPractitioner(
        makeUser({
          name: "Sarah Marie Jones",
          name_family: "Jones",
          name_given: ["Sarah", "Marie"],
        }),
      );
      expect(p.name?.[0]?.family).toBe("Jones");
      expect(p.name?.[0]?.given).toEqual(["Sarah", "Marie"]);
    });

    it("falls back to parseName when name_family is null (unbackfilled row)", () => {
      const p = toFhirPractitioner(
        makeUser({
          name: "Sarah Jones",
          name_family: null,
          name_given: null,
        }),
      );
      // Heuristic two-token result.
      expect(p.name?.[0]?.family).toBe("Jones");
      expect(p.name?.[0]?.given).toEqual(["Sarah"]);
    });

    it("structured columns carry through name_prefix and name_suffix", () => {
      const p = toFhirPractitioner(
        makeUser({
          name: "Dr. Sarah Jones, MD",
          name_family: "Jones",
          name_given: ["Sarah"],
          name_prefix: "Dr.",
          name_suffix: "MD",
        }),
      );
      expect(p.name?.[0]?.family).toBe("Jones");
      expect(p.name?.[0]?.given).toEqual(["Sarah"]);
      expect(p.name?.[0]?.prefix).toEqual(["Dr."]);
      expect(p.name?.[0]?.suffix).toEqual(["MD"]);
    });

    it("structured columns preserve particles and two-part surnames verbatim", () => {
      // "Sarah de Klerk" → parseName produces family="de Klerk" via the
      // particle heuristic. The structured path doesn't run the heuristic —
      // the writer records family="de Klerk" directly.
      const p = toFhirPractitioner(
        makeUser({
          name: "Sarah de Klerk",
          name_family: "de Klerk",
          name_given: ["Sarah"],
        }),
      );
      expect(p.name?.[0]?.family).toBe("de Klerk");
      expect(p.name?.[0]?.given).toEqual(["Sarah"]);
    });

    it("empty name_given array does not produce an empty `given` field", () => {
      // Mononymic case via structured columns ("Plato" with name_given=[]).
      const p = toFhirPractitioner(
        makeUser({
          name: "Plato",
          name_family: "Plato",
          name_given: [],
        }),
      );
      expect(p.name?.[0]?.family).toBe("Plato");
      expect(p.name?.[0]?.given).toBeUndefined();
    });
  });

  describe("US Core Practitioner conformance (#947)", () => {
    // Fake but plausible identifiers — never use a real provider's NPI.
    const FAKE_NPI = "1234567890";
    const FAKE_NUCC = "207RC0000X"; // Cardiologist, Clinical Cardiac Electrophysiology

    it("with NPI + NUCC + specialty emits meta.profile = us-core-practitioner", () => {
      const p = toFhirPractitioner(
        makeUser({
          npi: FAKE_NPI,
          nucc_code: FAKE_NUCC,
          specialty: "Clinical Cardiac Electrophysiology",
        }),
      );
      expect(p.meta?.profile).toEqual([US_CORE_PRACTITIONER]);
      expect(p.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner",
      );
    });

    it("with NPI present, NPI identifier comes first with registered us-npi system", () => {
      const p = toFhirPractitioner(
        makeUser({
          id: "prov-123",
          npi: FAKE_NPI,
          nucc_code: FAKE_NUCC,
        }),
      );
      expect(p.identifier?.[0]?.system).toBe(US_NPI_IDENTIFIER_SYSTEM);
      expect(p.identifier?.[0]?.system).toBe("http://hl7.org/fhir/sid/us-npi");
      expect(p.identifier?.[0]?.value).toBe(FAKE_NPI);
      // The internal user-id identifier is preserved for local lookups.
      expect(p.identifier?.[1]?.system).toBe(
        `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
      );
      expect(p.identifier?.[1]?.value).toBe("prov-123");
    });

    it("with NUCC code, qualification carries NUCC coding alongside text", () => {
      const p = toFhirPractitioner(
        makeUser({
          npi: FAKE_NPI,
          nucc_code: FAKE_NUCC,
          specialty: "Clinical Cardiac Electrophysiology",
        }),
      );
      expect(p.qualification?.[0]?.code?.text).toBe(
        "Clinical Cardiac Electrophysiology",
      );
      expect(p.qualification?.[0]?.code?.coding).toEqual([
        {
          system: NUCC_TAXONOMY_SYSTEM,
          code: FAKE_NUCC,
        },
      ]);
      expect(p.qualification?.[0]?.code?.coding?.[0]?.system).toBe(
        "http://nucc.org/provider-taxonomy",
      );
    });

    it("with NUCC code but no specialty, qualification has coding only (no text)", () => {
      const p = toFhirPractitioner(
        makeUser({
          npi: FAKE_NPI,
          nucc_code: FAKE_NUCC,
          specialty: null,
        }),
      );
      expect(p.qualification?.[0]?.code?.coding?.[0]?.code).toBe(FAKE_NUCC);
      expect(p.qualification?.[0]?.code?.text).toBeUndefined();
    });

    it("without NPI and without NUCC: no meta.profile, urn-only identifier, text-only qualification", () => {
      const p = toFhirPractitioner(
        makeUser({
          id: "prov-7",
          npi: null,
          nucc_code: null,
          specialty: "Oncology",
        }),
      );
      // No conformance claim.
      expect(p.meta).toBeUndefined();
      // Internal identifier only.
      expect(p.identifier).toHaveLength(1);
      expect(p.identifier?.[0]?.system).toBe(
        `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
      );
      expect(p.identifier?.[0]?.value).toBe("prov-7");
      // Qualification stays text-only — pre-#947 behaviour.
      expect(p.qualification?.[0]?.code?.text).toBe("Oncology");
      expect(p.qualification?.[0]?.code?.coding).toBeUndefined();
    });

    it("NPI without NUCC: no meta.profile (gate requires both)", () => {
      // Even with a registered identifier, we don't claim conformance
      // until the NUCC qualification slice is also satisfied. Asserting
      // the profile here would still fail downstream validators.
      const p = toFhirPractitioner(
        makeUser({
          npi: FAKE_NPI,
          nucc_code: null,
          specialty: "Oncology",
        }),
      );
      expect(p.meta).toBeUndefined();
      // But the NPI identifier IS emitted regardless — it's a real
      // registered identifier and useful for consumers even without
      // the profile claim.
      expect(p.identifier?.[0]?.system).toBe(US_NPI_IDENTIFIER_SYSTEM);
    });

    it("NUCC without NPI: no meta.profile (gate requires both)", () => {
      const p = toFhirPractitioner(
        makeUser({
          npi: null,
          nucc_code: FAKE_NUCC,
          specialty: "Oncology",
        }),
      );
      expect(p.meta).toBeUndefined();
      // NUCC coding is still emitted — useful even without conformance.
      expect(p.qualification?.[0]?.code?.coding?.[0]?.code).toBe(FAKE_NUCC);
      // Only internal identifier, no NPI.
      expect(p.identifier).toHaveLength(1);
      expect(p.identifier?.[0]?.system).toBe(
        `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
      );
    });

    it("omits qualification entirely when specialty AND nucc_code are both null", () => {
      const p = toFhirPractitioner(
        makeUser({
          specialty: null,
          nucc_code: null,
        }),
      );
      expect(p.qualification).toBeUndefined();
    });
  });
});
