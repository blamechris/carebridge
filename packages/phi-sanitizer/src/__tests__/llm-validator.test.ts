import { describe, it, expect } from "vitest";
import { validateLLMResponse } from "../llm-validator.js";

function makeFlag(overrides: Record<string, unknown> = {}) {
  return {
    severity: "warning",
    category: "cross-specialty",
    summary: "Test finding",
    rationale: "This is the rationale for the test finding.",
    suggested_action: "Review the patient record.",
    notify_specialties: ["cardiology"],
    ...overrides,
  };
}

describe("validateLLMResponse", () => {
  it("accepts valid JSON with correct schema", () => {
    const input = JSON.stringify([makeFlag()]);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(1);
      expect(result.flags[0]!.severity).toBe("warning");
    }
  });

  it("returns ok: false for invalid JSON", () => {
    const result = validateLLMResponse("not json at all {[}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid JSON");
    }
  });

  it("returns ok: false when required fields are missing", () => {
    const input = JSON.stringify([{ severity: "warning" }]);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing");
    }
  });

  it("returns ok: false for invalid severity value", () => {
    const input = JSON.stringify([makeFlag({ severity: "extreme" })]);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid severity");
    }
  });

  it("returns ok: false for invalid category", () => {
    const input = JSON.stringify([makeFlag({ category: "made-up-category" })]);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid category");
    }
  });

  it("caps flags at 20", () => {
    const flags = Array.from({ length: 25 }, () => makeFlag());
    const input = JSON.stringify(flags);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(20);
      expect(result.warnings.some((w) => w.includes("truncated"))).toBe(true);
    }
  });

  it("strips markdown code fences before parsing", () => {
    const input = "```json\n" + JSON.stringify([makeFlag()]) + "\n```";
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(1);
    }
  });

  it("accepts empty array as valid", () => {
    const result = validateLLMResponse("[]");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(0);
    }
  });

  it("warns on suspicious flag count (>= 15)", () => {
    const flags = Array.from({ length: 16 }, () => makeFlag());
    const input = JSON.stringify(flags);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.some((w) => w.includes("Suspiciously high")),
      ).toBe(true);
    }
  });

  it("returns ok: false when response is not an array", () => {
    const result = validateLLMResponse(JSON.stringify({ flag: "value" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must be a JSON array");
    }
  });
});

describe("validateLLMResponse — residual PHI scan (Phase D P1)", () => {
  // Phase D P1 guard: any flag whose free-text fields contain PHI-shaped
  // patterns is dropped with a warning. The symmetry with
  // assertPromptSanitized() is intentional — patterns we refuse to send
  // are also patterns we refuse to receive.

  it("drops a flag whose summary contains an ISO date", () => {
    const clean = makeFlag();
    const contaminated = makeFlag({
      summary: "Patient seen on 2026-03-15 for worsening symptoms",
    });
    const result = validateLLMResponse(
      JSON.stringify([clean, contaminated]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(1);
      expect(result.flags[0]!.summary).toBe("Test finding");
      expect(
        result.warnings.some(
          (w) => w.includes("Flag[1]") && w.includes("summary:DATE_ISO"),
        ),
      ).toBe(true);
    }
  });

  it("drops a flag whose rationale contains an MRN label", () => {
    const contaminated = makeFlag({
      rationale: "MRN: 12345678 shows a history of prior admissions.",
    });
    const result = validateLLMResponse(JSON.stringify([contaminated]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(0);
      expect(
        result.warnings.some((w) => w.includes("rationale:MRN_LABELED")),
      ).toBe(true);
    }
  });

  it("drops a flag whose suggested_action contains an SSN", () => {
    const contaminated = makeFlag({
      suggested_action: "Verify identity against 123-45-6789 on file.",
    });
    const result = validateLLMResponse(JSON.stringify([contaminated]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(0);
      expect(
        result.warnings.some((w) => w.includes("suggested_action:SSN")),
      ).toBe(true);
    }
  });

  it("drops a flag whose rationale cites a dotted ICD-10 code", () => {
    const contaminated = makeFlag({
      rationale: "Evidence supports diagnosis I21.4 from last admission.",
    });
    const result = validateLLMResponse(JSON.stringify([contaminated]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(0);
      expect(
        result.warnings.some((w) =>
          w.includes("rationale:ICD10_DOTTED"),
        ),
      ).toBe(true);
    }
  });

  it("drops a flag containing a phone number in suggested_action", () => {
    const contaminated = makeFlag({
      suggested_action: "Call patient at (555) 123-4567 for follow-up.",
    });
    const result = validateLLMResponse(JSON.stringify([contaminated]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(0);
      expect(
        result.warnings.some((w) => w.includes("suggested_action:PHONE")),
      ).toBe(true);
    }
  });

  it("keeps clean flags and drops only the contaminated ones", () => {
    const flags = [
      makeFlag({ summary: "Clean finding one" }),
      makeFlag({ summary: "Seen 03/15/2026 for chest pain" }), // DATE_MDY
      makeFlag({ summary: "Clean finding two" }),
    ];
    const result = validateLLMResponse(JSON.stringify(flags));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(2);
      expect(result.flags[0]!.summary).toBe("Clean finding one");
      expect(result.flags[1]!.summary).toBe("Clean finding two");
      expect(
        result.warnings.some(
          (w) => w.includes("Flag[1]") && w.includes("DATE_MDY"),
        ),
      ).toBe(true);
    }
  });

  it("reports multiple violation labels when a flag contains several patterns", () => {
    const contaminated = makeFlag({
      summary: "Admitted on 2026-03-15",
      rationale: "MRN: 99887766 with history",
    });
    const result = validateLLMResponse(JSON.stringify([contaminated]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(0);
      const warning = result.warnings.find((w) =>
        w.includes("residual PHI patterns"),
      );
      expect(warning).toBeDefined();
      expect(warning).toContain("summary:DATE_ISO");
      expect(warning).toContain("rationale:MRN_LABELED");
    }
  });

  it("does not drop a flag whose free text is free of PHI patterns", () => {
    const clean = makeFlag({
      summary: "Elevated anticoagulant risk in patient with active malignancy",
      rationale: "Recent imaging shows lower extremity findings consistent with VTE.",
      suggested_action:
        "Consider neuro assessment and notify hematology on-call.",
    });
    const result = validateLLMResponse(JSON.stringify([clean]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    }
  });
});
