import { describe, it, expect } from "vitest";
import { toFhirEncounter } from "../generators/encounter.js";

type Encounter = Parameters<typeof toFhirEncounter>[0];

function makeEncounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: "e1",
    patient_id: "p1",
    encounter_type: "outpatient",
    status: "finished",
    start_time: "2026-04-10T10:00:00.000Z",
    end_time: "2026-04-10T10:45:00.000Z",
    provider_id: "prov1",
    location: null,
    reason: null,
    notes: null,
    created_at: "2026-04-10T10:00:00.000Z",
    ...overrides,
  } as Encounter;
}

describe("toFhirEncounter (#387)", () => {
  describe("class mapping (HL7 v3 ActCode)", () => {
    const cases: Array<[string, string]> = [
      ["inpatient", "IMP"],
      ["outpatient", "AMB"],
      ["ambulatory", "AMB"],
      ["emergency", "EMER"],
      ["ED", "EMER"],
      ["telehealth", "VR"],
      ["virtual", "VR"],
      ["home", "HH"],
      ["observation", "OBSENC"],
    ];
    for (const [input, code] of cases) {
      it(`maps encounter_type '${input}' → class.code '${code}'`, () => {
        const enc = toFhirEncounter(makeEncounter({ encounter_type: input }), "p1");
        expect(enc.class.code).toBe(code);
        expect(enc.class.system).toBe(
          "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        );
      });
    }

    it("falls back to AMB for unknown encounter_type", () => {
      const enc = toFhirEncounter(makeEncounter({ encounter_type: "xyz" }), "p1");
      expect(enc.class.code).toBe("AMB");
    });
  });

  describe("status mapping", () => {
    const canonical = [
      "planned",
      "arrived",
      "triaged",
      "in-progress",
      "onleave",
      "finished",
      "cancelled",
      "entered-in-error",
      "unknown",
    ];
    for (const s of canonical) {
      it(`passes through canonical status '${s}'`, () => {
        const enc = toFhirEncounter(makeEncounter({ status: s }), "p1");
        expect(enc.status).toBe(s);
      });
    }

    it("maps unrecognised status to 'unknown'", () => {
      const enc = toFhirEncounter(makeEncounter({ status: "scheduled" }), "p1");
      expect(enc.status).toBe("unknown");
    });
  });

  describe("subject / period / participant / reason", () => {
    it("attaches a Patient reference", () => {
      const enc = toFhirEncounter(makeEncounter(), "p1");
      expect(enc.subject?.reference).toBe("Patient/p1");
    });

    it("emits period.start and period.end when both present", () => {
      const enc = toFhirEncounter(
        makeEncounter({
          start_time: "2026-04-10T10:00:00.000Z",
          end_time: "2026-04-10T10:45:00.000Z",
        }),
        "p1",
      );
      expect(enc.period?.start).toBe("2026-04-10T10:00:00.000Z");
      expect(enc.period?.end).toBe("2026-04-10T10:45:00.000Z");
    });

    it("omits period.end for open-ended in-progress encounters", () => {
      const enc = toFhirEncounter(
        makeEncounter({ end_time: null, status: "in-progress" }),
        "p1",
      );
      expect(enc.period?.start).toBe("2026-04-10T10:00:00.000Z");
      expect(enc.period?.end).toBeUndefined();
    });

    it("includes a Practitioner participant when provider_id set", () => {
      const enc = toFhirEncounter(makeEncounter({ provider_id: "prov99" }), "p1");
      expect(enc.participant?.[0]?.individual?.reference).toBe("Practitioner/prov99");
    });

    it("omits participant when provider_id is null", () => {
      const enc = toFhirEncounter(makeEncounter({ provider_id: null }), "p1");
      expect(enc.participant).toBeUndefined();
    });

    it("maps encounter.location to a FHIR Encounter.location reference with display text", () => {
      const enc = toFhirEncounter(
        makeEncounter({ location: "Main Hospital, Room 302B" }),
        "p1",
      );
      expect(enc.location?.[0]?.location?.display).toBe("Main Hospital, Room 302B");
    });

    it("omits Encounter.location when the column is null", () => {
      const enc = toFhirEncounter(makeEncounter({ location: null }), "p1");
      expect(enc.location).toBeUndefined();
    });

    it("includes reasonCode when reason set", () => {
      const enc = toFhirEncounter(
        makeEncounter({ reason: "Chest pain workup" }),
        "p1",
      );
      expect(enc.reasonCode?.[0]?.text).toBe("Chest pain workup");
    });
  });
});
