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
