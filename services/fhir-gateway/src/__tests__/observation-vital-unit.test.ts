/**
 * Tests for vital unit propagation in FHIR Observation export (#985).
 *
 * Background
 * ----------
 * The original observation generator hardcoded the FHIR Quantity unit per
 * vital type — temperature → [degF], weight → [lb_av] — and IGNORED the
 * stored vital.unit. A row persisted as `{value: 37, unit: "degC"}`
 * exported as `valueQuantity.value = 37, code = [degF]`. A patient at 37°C
 * (normal) consumed by a downstream system (Epic, registries, patient
 * share workflows) reads as 37°F — severe hypothermia, lethal. This is the
 * single most dangerous misalignment in clinical data.
 *
 * These tests pin the contract: read vital.unit, emit UCUM-correct codes,
 * never silently re-label a Celsius reading as Fahrenheit.
 */

import { describe, it, expect } from "vitest";
import { toFhirVitalObservation } from "../generators/observation.js";
import type { Vital } from "@carebridge/shared-types";

function vital(overrides: Partial<Vital> & { type: Vital["type"]; value_primary: number; unit: string }): Vital {
  return {
    id: "vit-1",
    patient_id: "pat-1",
    recorded_at: "2026-05-21T12:00:00.000Z",
    created_at: "2026-05-21T12:00:00.000Z",
    updated_at: "2026-05-21T12:00:00.000Z",
    ...overrides,
  } as Vital;
}

describe("FHIR Observation vital unit propagation (#985)", () => {
  describe("temperature", () => {
    it("Celsius reading exports as Cel (NOT [degF])", () => {
      const obs = toFhirVitalObservation(
        vital({ type: "temperature", value_primary: 37, unit: "°C" }),
        "pat-1",
      );
      expect(obs.valueQuantity?.value).toBe(37);
      expect(obs.valueQuantity?.code).toBe("Cel");
      // unit display string preserves the stored form for human readability
      // but the machine code must be UCUM-correct
      expect(obs.valueQuantity?.code).not.toBe("[degF]");
    });

    it("alternate Celsius spellings all map to Cel", () => {
      for (const unit of ["°C", "degC", "C", "Cel", "celsius"]) {
        const obs = toFhirVitalObservation(
          vital({ type: "temperature", value_primary: 37, unit }),
          "pat-1",
        );
        expect(obs.valueQuantity?.code, `unit input: ${unit}`).toBe("Cel");
      }
    });

    it("Fahrenheit reading exports as [degF]", () => {
      const obs = toFhirVitalObservation(
        vital({ type: "temperature", value_primary: 98.6, unit: "°F" }),
        "pat-1",
      );
      expect(obs.valueQuantity?.code).toBe("[degF]");
    });
  });

  describe("weight", () => {
    it("kilograms reading exports as kg (NOT [lb_av])", () => {
      const obs = toFhirVitalObservation(
        vital({ type: "weight", value_primary: 70, unit: "kg" }),
        "pat-1",
      );
      expect(obs.valueQuantity?.value).toBe(70);
      expect(obs.valueQuantity?.code).toBe("kg");
      expect(obs.valueQuantity?.code).not.toBe("[lb_av]");
    });

    it("pounds reading exports as [lb_av]", () => {
      const obs = toFhirVitalObservation(
        vital({ type: "weight", value_primary: 154, unit: "lbs" }),
        "pat-1",
      );
      expect(obs.valueQuantity?.code).toBe("[lb_av]");
    });
  });

  describe("non-temperature/weight vitals also read vital.unit", () => {
    it("blood_pressure mmHg → mm[Hg]", () => {
      const obs = toFhirVitalObservation(
        vital({
          type: "blood_pressure",
          value_primary: 120,
          value_secondary: 80,
          unit: "mmHg",
        }),
        "pat-1",
      );
      const systolic = obs.component?.[0]?.valueQuantity;
      const diastolic = obs.component?.[1]?.valueQuantity;
      expect(systolic?.code).toBe("mm[Hg]");
      expect(diastolic?.code).toBe("mm[Hg]");
    });

    it("heart_rate bpm → /min", () => {
      const obs = toFhirVitalObservation(
        vital({ type: "heart_rate", value_primary: 80, unit: "bpm" }),
        "pat-1",
      );
      expect(obs.valueQuantity?.code).toBe("/min");
    });

    it("o2_sat % → %", () => {
      const obs = toFhirVitalObservation(
        vital({ type: "o2_sat", value_primary: 98, unit: "%" }),
        "pat-1",
      );
      expect(obs.valueQuantity?.code).toBe("%");
    });
  });

  it("unknown unit falls back to text-only Quantity (no system + code)", () => {
    const obs = toFhirVitalObservation(
      vital({ type: "temperature", value_primary: 37, unit: "WHATEVER" }),
      "pat-1",
    );
    expect(obs.valueQuantity?.value).toBe(37);
    expect(obs.valueQuantity?.unit).toBe("WHATEVER");
    // No UCUM system claim when the unit isn't recognised — better to omit
    // than to lie under the UCUM URL.
    expect(obs.valueQuantity?.system).toBeUndefined();
    expect(obs.valueQuantity?.code).toBeUndefined();
  });
});
