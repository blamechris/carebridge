import { describe, it, expect } from "vitest";
import { toFhirPractitioner, isClinicalRole } from "../generators/practitioner.js";

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
      "https://carebridge.dev/fhir/sid/user-id",
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
});
