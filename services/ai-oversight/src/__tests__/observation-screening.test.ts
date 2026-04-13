import { describe, it, expect } from "vitest";
import { screenPatientObservation } from "../rules/observation-screening.js";
import type { ClinicalEvent } from "@carebridge/shared-types";

/**
 * Helper to build a patient.observation event with a given description.
 */
function makeObservationEvent(description: string): ClinicalEvent {
  return {
    id: "evt-obs-1",
    type: "patient.observation",
    patient_id: "p-1",
    data: {
      observation_id: "obs-1",
      observation_type: "neurological",
      observation_description: description,
    },
    timestamp: new Date().toISOString(),
  };
}

describe("screenPatientObservation", () => {
  // ── Critical patterns ────────────────────────────────────────────

  it("flags 'worst headache ever' as critical", () => {
    const event = makeObservationEvent("I have the worst headache of my life");
    const flags = screenPatientObservation(event);

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("OBS-SEVERE-HEADACHE");
    expect(flags[0]!.category).toBe("patient-reported");
    expect(flags[0]!.notify_specialties).toContain("neurology");
  });

  it("flags 'worst headache' with surrounding text", () => {
    const event = makeObservationEvent(
      "Started having the worst headache around noon, still not going away",
    );
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const headacheFlag = flags.find((f) => f.rule_id === "OBS-SEVERE-HEADACHE");
    expect(headacheFlag).toBeDefined();
    expect(headacheFlag!.severity).toBe("critical");
  });

  it("flags chest pain as critical", () => {
    const event = makeObservationEvent("Having chest pain when I walk");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const chestFlag = flags.find((f) => f.rule_id === "OBS-CHEST-PAIN");
    expect(chestFlag).toBeDefined();
    expect(chestFlag!.severity).toBe("critical");
  });

  it("flags breathing difficulty as critical", () => {
    const event = makeObservationEvent("I can't breathe well at night");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const breathFlag = flags.find((f) => f.rule_id === "OBS-BREATHING");
    expect(breathFlag).toBeDefined();
    expect(breathFlag!.severity).toBe("critical");
  });

  it("flags suicidal ideation as critical", () => {
    const event = makeObservationEvent("I just want to die");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const suicidalFlag = flags.find((f) => f.rule_id === "OBS-SUICIDAL");
    expect(suicidalFlag).toBeDefined();
    expect(suicidalFlag!.severity).toBe("critical");
    expect(suicidalFlag!.notify_specialties).toContain("psychiatry");
  });

  it("flags stroke symptoms as critical", () => {
    const event = makeObservationEvent("I have slurred speech and sudden numbness on one side");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const strokeFlag = flags.find((f) => f.rule_id === "OBS-STROKE-SYMPTOMS");
    expect(strokeFlag).toBeDefined();
    expect(strokeFlag!.severity).toBe("critical");
  });

  // ── High/warning patterns ────────────────────────────────────────

  it("flags 'blood in stool' as critical", () => {
    const event = makeObservationEvent("I noticed blood in stool this morning");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const bleedFlag = flags.find((f) => f.rule_id === "OBS-BLEEDING");
    expect(bleedFlag).toBeDefined();
    expect(bleedFlag!.severity).toBe("critical");
  });

  it("flags severe pain as warning", () => {
    const event = makeObservationEvent("Experiencing severe pain in my lower back");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const painFlag = flags.find((f) => f.rule_id === "OBS-SEVERE-PAIN");
    expect(painFlag).toBeDefined();
    expect(painFlag!.severity).toBe("warning");
  });

  it("flags fainting as warning", () => {
    const event = makeObservationEvent("I fainted twice today");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const faintFlag = flags.find((f) => f.rule_id === "OBS-FAINTING");
    expect(faintFlag).toBeDefined();
    expect(faintFlag!.severity).toBe("warning");
  });

  it("flags seizure as warning", () => {
    const event = makeObservationEvent("I had what I think was a seizure");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const seizureFlag = flags.find((f) => f.rule_id === "OBS-SEIZURE");
    expect(seizureFlag).toBeDefined();
    expect(seizureFlag!.severity).toBe("warning");
  });

  it("flags high fever as warning", () => {
    const event = makeObservationEvent("I have a high fever that won't go down");
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const feverFlag = flags.find((f) => f.rule_id === "OBS-HIGH-FEVER");
    expect(feverFlag).toBeDefined();
    expect(feverFlag!.severity).toBe("warning");
  });

  // ── No-match cases ───────────────────────────────────────────────

  it("returns no flags for 'mild nausea'", () => {
    const event = makeObservationEvent("Feeling a bit of mild nausea after meals");
    const flags = screenPatientObservation(event);

    expect(flags).toHaveLength(0);
  });

  it("returns no flags for benign observation", () => {
    const event = makeObservationEvent("Slept well last night, appetite is improving");
    const flags = screenPatientObservation(event);

    expect(flags).toHaveLength(0);
  });

  it("returns no flags for empty description", () => {
    const event: ClinicalEvent = {
      id: "evt-obs-empty",
      type: "patient.observation",
      patient_id: "p-1",
      data: {
        observation_id: "obs-2",
        observation_type: "general",
      },
      timestamp: new Date().toISOString(),
    };
    const flags = screenPatientObservation(event);

    expect(flags).toHaveLength(0);
  });

  // ── Multiple matches ─────────────────────────────────────────────

  it("returns multiple flags when description matches several patterns", () => {
    const event = makeObservationEvent(
      "Having chest pain, can't breathe, and the worst headache of my life",
    );
    const flags = screenPatientObservation(event);

    expect(flags.length).toBeGreaterThanOrEqual(3);

    const ruleIds = flags.map((f) => f.rule_id);
    expect(ruleIds).toContain("OBS-CHEST-PAIN");
    expect(ruleIds).toContain("OBS-BREATHING");
    expect(ruleIds).toContain("OBS-SEVERE-HEADACHE");
  });

  // ── Works without LLM ────────────────────────────────────────────

  it("operates purely on keyword matching with no external dependencies", () => {
    // This test verifies the function is self-contained and deterministic.
    // No mocks needed — it does not call any API or database.
    const event = makeObservationEvent("kill myself");
    const flags = screenPatientObservation(event);

    expect(flags).toHaveLength(1);
    expect(flags[0]!.rule_id).toBe("OBS-SUICIDAL");
  });
});
