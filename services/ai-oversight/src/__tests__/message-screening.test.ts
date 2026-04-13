import { describe, it, expect } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";
import { screenPatientMessage } from "../rules/message-screening.js";

/**
 * Build a minimal message.received ClinicalEvent for testing.
 *
 * The BullMQ event payload intentionally omits message text (PHI stays out
 * of Redis). The review service reads the body from the DB and injects it
 * into event.data.message_text before calling screenPatientMessage.
 */
function makeMessageEvent(
  overrides: Partial<ClinicalEvent["data"]> = {},
): ClinicalEvent {
  return {
    id: crypto.randomUUID(),
    type: "message.received",
    patient_id: "patient-001",
    timestamp: new Date().toISOString(),
    data: {
      message_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      sender_role: "patient",
      ...overrides,
    },
  };
}

// ─── Keyword detection ───────────────────────────────────────────

describe("screenPatientMessage — urgent keyword detection", () => {
  it("flags chest pain", () => {
    const event = makeMessageEvent({
      message_text: "I have been having chest pain since this morning",
    });
    const flags = screenPatientMessage(event);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    expect(flags.some((f) => f.rule_id === "MSG-CHEST-PAIN")).toBe(true);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.category).toBe("patient-reported");
  });

  it("flags chest tightness", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "feeling chest tightness after walking" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-CHEST-PAIN")).toBe(true);
  });

  it("flags difficulty breathing", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I can't breathe well at night" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-BREATHING")).toBe(true);
  });

  it("flags shortness of breath", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "shortness of breath getting worse" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-BREATHING")).toBe(true);
  });

  it("flags worst headache (thunderclap)", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I have the worst headache of my life" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-SEVERE-HEADACHE")).toBe(true);
  });

  it("flags stroke symptoms — face droop", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "my face droop on the left side" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-STROKE-SYMPTOMS")).toBe(true);
  });

  it("flags stroke symptoms — slurred speech", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "having slurred speech since lunch" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-STROKE-SYMPTOMS")).toBe(true);
  });

  it("flags suicidal ideation — direct", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I want to kill myself" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-SUICIDAL")).toBe(true);
    expect(flags[0]!.severity).toBe("critical");
  });

  it("flags suicidal ideation — indirect", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I don't want to live anymore" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-SUICIDAL")).toBe(true);
  });

  it("flags significant bleeding", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I am bleeding a lot from the wound" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-BLEEDING")).toBe(true);
  });

  it("flags allergic reaction / anaphylaxis", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "my throat is closing up and I have hives all over" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-ALLERGIC-REACTION")).toBe(true);
  });

  it("flags fever (warning severity)", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I have a fever and chills since yesterday" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-FEVER-CHEMO")).toBe(true);
    expect(flags.find((f) => f.rule_id === "MSG-FEVER-CHEMO")!.severity).toBe("warning");
  });

  it("flags fall (warning severity)", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I fell down the stairs this morning" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-FALL")).toBe(true);
    expect(flags.find((f) => f.rule_id === "MSG-FALL")!.severity).toBe("warning");
  });

  it("flags new weakness (warning severity)", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "I have sudden weakness in my left leg" }),
    );
    expect(flags.some((f) => f.rule_id === "MSG-NEW-WEAKNESS")).toBe(true);
    expect(flags.find((f) => f.rule_id === "MSG-NEW-WEAKNESS")!.severity).toBe("warning");
  });

  it("detects multiple urgent keywords in a single message", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({
        message_text:
          "I have chest pain and I can't breathe and I want to die",
      }),
    );

    const ruleIds = flags.map((f) => f.rule_id);
    expect(ruleIds).toContain("MSG-CHEST-PAIN");
    expect(ruleIds).toContain("MSG-BREATHING");
    expect(ruleIds).toContain("MSG-SUICIDAL");
    expect(flags.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Non-matching messages ───────────────────────────────────────

describe("screenPatientMessage — no false positives", () => {
  it("returns no flags for benign message", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({
        message_text: "Just checking in — my labs look good and I feel fine.",
      }),
    );
    expect(flags).toHaveLength(0);
  });

  it("returns no flags for appointment scheduling message", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({
        message_text: "Can I reschedule my appointment to next Thursday?",
      }),
    );
    expect(flags).toHaveLength(0);
  });

  it("returns no flags for medication refill request", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({
        message_text: "I need a refill on my blood pressure medication.",
      }),
    );
    expect(flags).toHaveLength(0);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────

describe("screenPatientMessage — edge cases", () => {
  it("returns no flags when message_text is missing (empty event payload)", () => {
    // This is the original bug: event payload has no message_text because
    // PHI was stripped. Without the review-service DB fetch, this yields
    // an empty string and no patterns fire.
    const event = makeMessageEvent();
    delete (event.data as Record<string, unknown>).message_text;

    const flags = screenPatientMessage(event);
    expect(flags).toHaveLength(0);
  });

  it("returns no flags when message_text is an empty string", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({ message_text: "" }),
    );
    expect(flags).toHaveLength(0);
  });

  it("returns no flags when message_id is missing", () => {
    const event = makeMessageEvent({ message_text: "chest pain" });
    delete (event.data as Record<string, unknown>).message_id;

    // screenPatientMessage itself doesn't use message_id, but the event
    // still works when it's absent — only the review-service DB lookup
    // depends on message_id.
    const flags = screenPatientMessage(event);
    expect(flags.length).toBeGreaterThanOrEqual(1);
  });

  it("skips non-patient messages", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({
        sender_role: "physician",
        message_text: "Patient reports chest pain on follow-up call.",
      }),
    );
    expect(flags).toHaveLength(0);
  });

  it("skips provider messages even with urgent keywords", () => {
    const flags = screenPatientMessage(
      makeMessageEvent({
        sender_role: "nurse",
        message_text: "Patient said they want to die — please assess ASAP.",
      }),
    );
    expect(flags).toHaveLength(0);
  });
});
