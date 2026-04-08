import { describe, it, expect } from "vitest";
import {
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_SYSTEM_PROMPT,
  buildNoteExtractionPrompt,
  parseNoteExtractionResponse,
  renderNoteBodyForExtraction,
  EMPTY_NOTE_ASSERTIONS,
} from "../note-extraction.js";

describe("NOTE_EXTRACTION_SYSTEM_PROMPT", () => {
  it("pins the prompt version", () => {
    expect(NOTE_EXTRACTION_PROMPT_VERSION).toBe("1.0.0");
  });

  it("forbids inventing data", () => {
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toMatch(/Do NOT invent/);
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toMatch(/Do NOT compute relative dates/);
  });

  it("enforces JSON-only output", () => {
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toMatch(/Respond ONLY with the JSON object/);
  });

  it("forbids patient identifiers in payload", () => {
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toMatch(/Never include patient identifiers/);
  });
});

describe("buildNoteExtractionPrompt", () => {
  it("includes template type and note body verbatim", () => {
    const prompt = buildNoteExtractionPrompt({
      template_type: "soap",
      note_body: "Subjective: denies chest pain.",
    });
    expect(prompt).toMatch(/TEMPLATE TYPE: soap/);
    expect(prompt).toMatch(/Subjective: denies chest pain\./);
  });
});

describe("renderNoteBodyForExtraction", () => {
  it("renders structured fields and free text per section", () => {
    const rendered = renderNoteBodyForExtraction([
      {
        label: "Subjective",
        fields: [
          { label: "Chief Complaint", value: "headache" },
          { label: "HPI", value: "Started 3 days ago." },
        ],
        free_text: "Patient denies chest pain.",
      },
      {
        label: "Assessment",
        fields: [{ label: "Problem", value: "migraine" }],
      },
    ]);
    expect(rendered).toMatch(/--- Subjective ---/);
    expect(rendered).toMatch(/Chief Complaint: headache/);
    expect(rendered).toMatch(/HPI: Started 3 days ago\./);
    expect(rendered).toMatch(/Patient denies chest pain\./);
    expect(rendered).toMatch(/--- Assessment ---/);
    expect(rendered).toMatch(/Problem: migraine/);
  });

  it("skips null / empty fields", () => {
    const rendered = renderNoteBodyForExtraction([
      {
        label: "Plan",
        fields: [
          { label: "Rx", value: null },
          { label: "Followup", value: "" },
          { label: "Labs", value: ["CBC", "BMP"] },
        ],
      },
    ]);
    expect(rendered).not.toMatch(/Rx:/);
    expect(rendered).not.toMatch(/Followup:/);
    expect(rendered).toMatch(/Labs: CBC, BMP/);
  });
});

describe("parseNoteExtractionResponse", () => {
  const validResponse = {
    symptoms_reported: [
      {
        name: "chest pain",
        onset: "3 days ago",
        severity: "8/10",
        evidence_quote: "Patient reports chest pain for 3 days, 8/10.",
      },
    ],
    symptoms_denied: ["shortness of breath", "fever"],
    assessments: [
      {
        problem: "acute coronary syndrome",
        status: "new",
        evidence_quote: "A: Concern for ACS.",
      },
    ],
    plan_items: [
      {
        action: "order troponin",
        target_followup: "1 hour",
        ordered_by_specialty: "cardiology",
        evidence_quote: "Plan: Troponin in 1h per cards.",
      },
    ],
    referenced_results: [
      {
        type: "echo",
        value: "EF 55%",
        asserted_date: "May",
        evidence_quote: "Echo from May showed EF 55%.",
      },
    ],
    one_line_summary: "Patient presents with 3 days of 8/10 chest pain, ACS workup initiated.",
  };

  it("parses a well-formed response", () => {
    const result = parseNoteExtractionResponse(JSON.stringify(validResponse));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.symptoms_reported).toHaveLength(1);
      expect(result.payload.symptoms_reported[0].name).toBe("chest pain");
      expect(result.payload.symptoms_denied).toEqual([
        "shortness of breath",
        "fever",
      ]);
      expect(result.payload.assessments[0].status).toBe("new");
      expect(result.payload.plan_items[0].ordered_by_specialty).toBe("cardiology");
      expect(result.payload.referenced_results[0].type).toBe("echo");
      expect(result.payload.one_line_summary).toMatch(/chest pain/);
    }
  });

  it("strips markdown code fencing", () => {
    const fenced = "```json\n" + JSON.stringify(validResponse) + "\n```";
    const result = parseNoteExtractionResponse(fenced);
    expect(result.ok).toBe(true);
  });

  it("rejects empty response", () => {
    const result = parseNoteExtractionResponse("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/);
  });

  it("rejects invalid JSON", () => {
    const result = parseNoteExtractionResponse("not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });

  it("rejects JSON arrays", () => {
    const result = parseNoteExtractionResponse("[]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a JSON object/);
  });

  it("normalizes missing collection keys to empty arrays", () => {
    const result = parseNoteExtractionResponse(
      JSON.stringify({ one_line_summary: "routine follow-up" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.symptoms_reported).toEqual([]);
      expect(result.payload.symptoms_denied).toEqual([]);
      expect(result.payload.assessments).toEqual([]);
      expect(result.payload.plan_items).toEqual([]);
      expect(result.payload.referenced_results).toEqual([]);
      expect(result.payload.one_line_summary).toBe("routine follow-up");
    }
  });

  it("drops malformed items within a collection without failing the whole parse", () => {
    const result = parseNoteExtractionResponse(
      JSON.stringify({
        symptoms_reported: [
          { name: "headache", onset: "today", severity: null, evidence_quote: null },
          { onset: "yesterday" }, // missing name — dropped
          "not-an-object", // wrong type — dropped
          { name: "", severity: "mild" }, // empty name — dropped
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.symptoms_reported).toHaveLength(1);
      expect(result.payload.symptoms_reported[0].name).toBe("headache");
    }
  });

  it("clamps evidence quotes to 240 chars", () => {
    const longQuote = "x".repeat(400);
    const result = parseNoteExtractionResponse(
      JSON.stringify({
        symptoms_reported: [
          { name: "fatigue", evidence_quote: longQuote },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.symptoms_reported[0].evidence_quote?.length).toBe(240);
    }
  });

  it("clamps one_line_summary to 480 chars", () => {
    const longSummary = "y".repeat(1000);
    const result = parseNoteExtractionResponse(
      JSON.stringify({ one_line_summary: longSummary }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.one_line_summary.length).toBe(480);
    }
  });

  it("normalizes assessment.status to 'unknown' for unexpected values", () => {
    const result = parseNoteExtractionResponse(
      JSON.stringify({
        assessments: [
          { problem: "pneumonia", status: "getting better" }, // invalid
          { problem: "hypertension", status: "stable" }, // valid
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.assessments[0].status).toBe("unknown");
      expect(result.payload.assessments[1].status).toBe("stable");
    }
  });

  it("lowercases symptom names for stable downstream matching", () => {
    const result = parseNoteExtractionResponse(
      JSON.stringify({
        symptoms_reported: [{ name: "Chest Pain" }],
        symptoms_denied: ["  SHORTNESS of Breath  ", ""],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.symptoms_reported[0].name).toBe("chest pain");
      expect(result.payload.symptoms_denied).toEqual(["shortness of breath"]);
    }
  });

  it("caps collections at 50 items to prevent runaway payloads", () => {
    const bigList = Array.from({ length: 100 }, (_, i) => ({
      name: `symptom-${i}`,
    }));
    const result = parseNoteExtractionResponse(
      JSON.stringify({ symptoms_reported: bigList }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.symptoms_reported).toHaveLength(50);
    }
  });

  it("drops referenced_results with missing type or value", () => {
    const result = parseNoteExtractionResponse(
      JSON.stringify({
        referenced_results: [
          { type: "echo", value: "EF 55%" }, // kept
          { type: "", value: "x" }, // dropped
          { type: "ct", value: "" }, // dropped
          { type: "mri" }, // dropped
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.referenced_results).toHaveLength(1);
      expect(result.payload.referenced_results[0].type).toBe("echo");
    }
  });
});

describe("EMPTY_NOTE_ASSERTIONS", () => {
  it("has all required keys as empty collections", () => {
    expect(EMPTY_NOTE_ASSERTIONS.symptoms_reported).toEqual([]);
    expect(EMPTY_NOTE_ASSERTIONS.symptoms_denied).toEqual([]);
    expect(EMPTY_NOTE_ASSERTIONS.assessments).toEqual([]);
    expect(EMPTY_NOTE_ASSERTIONS.plan_items).toEqual([]);
    expect(EMPTY_NOTE_ASSERTIONS.referenced_results).toEqual([]);
    expect(EMPTY_NOTE_ASSERTIONS.one_line_summary).toBe("");
  });
});
