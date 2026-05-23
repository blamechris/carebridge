/**
 * Inbound FHIR Patient → internal `patients` row mapper tests (#337).
 *
 * Mirrors the structure of medication-mapper.test.ts: full-resource happy
 * path, missing fields, identifier-only, entered-in-error skip, and the
 * gender → biological_sex enum mapping.
 */
import { describe, it, expect } from "vitest";
import {
  mapFhirPatientToRow,
  extractPatientName,
  extractMrn,
  mapGenderToSex,
  type InboundPatient,
} from "../patient-mapper.js";

describe("mapFhirPatientToRow (#337)", () => {
  it("maps a fully-populated Patient to a row with every field set", () => {
    const resource: InboundPatient = {
      resourceType: "Patient",
      id: "pat-1",
      identifier: [
        {
          use: "usual",
          type: {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/v2-0203",
                code: "MR",
                display: "Medical Record Number",
              },
            ],
          },
          system: "https://carebridge.dev/fhir/sid/mrn",
          value: "MRN-12345",
        },
      ],
      name: [
        {
          use: "official",
          family: "Doe",
          given: ["Jane", "Marie"],
          text: "Jane Marie Doe",
        },
      ],
      birthDate: "1980-05-12",
      gender: "female",
    };
    const row = mapFhirPatientToRow(resource);
    expect(row).not.toBeNull();
    expect(row!).toEqual({
      name: "Jane Marie Doe",
      date_of_birth: "1980-05-12",
      biological_sex: "female",
      mrn: "MRN-12345",
      source_system: "fhir_import",
    });
  });

  it("returns null when the resource has no name and no identifier", () => {
    // A Patient with no name AND no MRN is unidentifiable — refuse to
    // create a row rather than landing an anonymous patient in the table.
    const resource: InboundPatient = {
      resourceType: "Patient",
      id: "pat-empty",
    };
    expect(mapFhirPatientToRow(resource)).toBeNull();
  });

  it("uses identifier as a placeholder name when only the MRN is present", () => {
    // Identifier-only Patient — the FHIR resource carries a real MRN
    // but no demographic name. We materialise with the MRN string as the
    // placeholder so the row is still identifiable downstream.
    const resource: InboundPatient = {
      resourceType: "Patient",
      identifier: [
        {
          type: {
            coding: [
              { system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" },
            ],
          },
          value: "MRN-99999",
        },
      ],
    };
    const row = mapFhirPatientToRow(resource);
    expect(row).not.toBeNull();
    expect(row!.mrn).toBe("MRN-99999");
    expect(row!.name).toBe("MRN-99999");
  });

  it("returns null when active=false (entered-in-error equivalent)", () => {
    // FHIR Patient has no `entered-in-error` status enum, but active=false
    // is the equivalent "do not materialise" signal — the chart entry has
    // been retired and should not propagate into the internal patient set.
    const resource: InboundPatient = {
      resourceType: "Patient",
      active: false,
      name: [{ family: "Ghost" }],
      gender: "unknown",
    };
    expect(mapFhirPatientToRow(resource)).toBeNull();
  });

  it("composes name from family + given when text is missing", () => {
    const resource: InboundPatient = {
      resourceType: "Patient",
      name: [{ family: "Smith", given: ["John", "Q"] }],
    };
    const row = mapFhirPatientToRow(resource);
    expect(row?.name).toBe("John Q Smith");
  });

  it("uses single-token family-only when given is missing", () => {
    const resource: InboundPatient = {
      resourceType: "Patient",
      name: [{ family: "Cher" }],
    };
    expect(mapFhirPatientToRow(resource)?.name).toBe("Cher");
  });

  it("prefers official use over usual when both are present", () => {
    const resource: InboundPatient = {
      resourceType: "Patient",
      name: [
        { use: "usual", text: "Johnny Smith" },
        { use: "official", text: "Jonathan Smith" },
      ],
    };
    expect(mapFhirPatientToRow(resource)?.name).toBe("Jonathan Smith");
  });

  it("falls back to first name entry when no official/usual present", () => {
    const resource: InboundPatient = {
      resourceType: "Patient",
      name: [
        { use: "nickname", text: "JD" },
        { use: "old", text: "Old Name" },
      ],
    };
    expect(mapFhirPatientToRow(resource)?.name).toBe("JD");
  });

  it("birthDate stays in YYYY-MM-DD form", () => {
    const resource: InboundPatient = {
      resourceType: "Patient",
      name: [{ family: "Doe" }],
      birthDate: "1980-05-12",
    };
    expect(mapFhirPatientToRow(resource)?.date_of_birth).toBe("1980-05-12");
  });

  it("birthDate left null when absent", () => {
    const resource: InboundPatient = {
      resourceType: "Patient",
      name: [{ family: "Doe" }],
    };
    expect(mapFhirPatientToRow(resource)?.date_of_birth).toBeNull();
  });
});

describe("extractPatientName (#337)", () => {
  it("returns null when name array is absent or empty", () => {
    expect(extractPatientName(undefined)).toBeNull();
    expect(extractPatientName([])).toBeNull();
  });

  it("prefers entries with use='official' over 'usual'", () => {
    expect(
      extractPatientName([
        { use: "usual", text: "Usual Smith" },
        { use: "official", text: "Official Smith" },
      ]),
    ).toBe("Official Smith");
  });

  it("falls back to use='usual' when no official entry", () => {
    expect(
      extractPatientName([
        { use: "nickname", text: "Nick" },
        { use: "usual", text: "Usual Smith" },
      ]),
    ).toBe("Usual Smith");
  });

  it("prefers .text over composed family+given", () => {
    expect(
      extractPatientName([
        {
          use: "official",
          text: "Dr. Jane M. Doe Jr.",
          family: "Doe",
          given: ["Jane", "M."],
        },
      ]),
    ).toBe("Dr. Jane M. Doe Jr.");
  });

  it("composes 'given... family' when text missing", () => {
    expect(
      extractPatientName([{ family: "Doe", given: ["Jane", "Marie"] }]),
    ).toBe("Jane Marie Doe");
  });

  it("returns null when an entry has neither text nor family nor given", () => {
    expect(extractPatientName([{ use: "official" }])).toBeNull();
  });

  it("returns given-only name when family missing", () => {
    expect(extractPatientName([{ given: ["Madonna"] }])).toBe("Madonna");
  });

  it("trims whitespace from composed result", () => {
    expect(extractPatientName([{ given: ["  John  "], family: " Smith " }]))
      .toBe("John Smith");
  });
});

describe("extractMrn (#337)", () => {
  it("returns null when identifier array is absent", () => {
    expect(extractMrn(undefined)).toBeNull();
    expect(extractMrn([])).toBeNull();
  });

  it("picks the identifier with type.coding.code='MR'", () => {
    expect(
      extractMrn([
        {
          type: { coding: [{ code: "SS", system: "ssn" }] },
          value: "111-22-3333",
        },
        {
          type: {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/v2-0203",
                code: "MR",
              },
            ],
          },
          value: "MRN-9000",
        },
      ]),
    ).toBe("MRN-9000");
  });

  it("falls back to system matching the CareBridge MRN system", () => {
    expect(
      extractMrn([
        {
          system: "https://carebridge.dev/fhir/sid/mrn",
          value: "MRN-CB-1",
        },
      ]),
    ).toBe("MRN-CB-1");
  });

  it("returns null when no identifier has MR type or MRN system", () => {
    expect(
      extractMrn([
        { type: { coding: [{ code: "SS" }] }, value: "111-22-3333" },
        { value: "no-type-no-system" },
      ]),
    ).toBeNull();
  });

  it("skips identifiers with no value even if MR-typed", () => {
    expect(
      extractMrn([
        { type: { coding: [{ code: "MR" }] } },
      ]),
    ).toBeNull();
  });
});

describe("mapGenderToSex (#337)", () => {
  it("maps FHIR genders to internal biological_sex enum", () => {
    expect(mapGenderToSex("male")).toBe("male");
    expect(mapGenderToSex("female")).toBe("female");
    // The internal enum is `male | female | unknown`; FHIR's `other`
    // collapses to `unknown` rather than coining a new value.
    expect(mapGenderToSex("other")).toBe("unknown");
    expect(mapGenderToSex("unknown")).toBe("unknown");
  });

  it("treats undefined and empty string as unknown", () => {
    expect(mapGenderToSex(undefined)).toBe("unknown");
    expect(mapGenderToSex("")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(mapGenderToSex("MALE")).toBe("male");
    expect(mapGenderToSex("Female")).toBe("female");
  });

  it("falls back to unknown for unrecognised values", () => {
    expect(mapGenderToSex("nonsense")).toBe("unknown");
  });
});
