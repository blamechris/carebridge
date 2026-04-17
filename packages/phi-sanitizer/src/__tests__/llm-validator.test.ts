import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateLLMResponse } from "../llm-validator.js";
import { MAX_FLAGS, SUSPICIOUS_FLAG_THRESHOLD } from "../constants.js";

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

  it("caps flags at the configured MAX and records truncation detail", () => {
    // 60 info-severity flags — above the 50 MAX_FLAGS cap.
    const flags = Array.from({ length: 60 }, () =>
      makeFlag({ severity: "info" }),
    );
    const input = JSON.stringify(flags);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(50);
      expect(result.warnings.some((w) => w.includes("truncated"))).toBe(true);
      expect(result.truncation).toBeDefined();
      expect(result.truncation?.receivedCount).toBe(60);
      expect(result.truncation?.keptCount).toBe(50);
      expect(result.truncation?.droppedCount).toBe(10);
      expect(result.truncation?.droppedBySeverity).toEqual({
        critical: 0,
        warning: 0,
        info: 10,
      });
    }
  });

  it("preserves all critical flags under truncation", () => {
    // 3 critical + 60 info (total 63, cap 50). Critical must all survive;
    // info is dropped first.
    const criticals = Array.from({ length: 3 }, (_, i) =>
      makeFlag({ severity: "critical", summary: `crit-${i}` }),
    );
    const infos = Array.from({ length: 60 }, (_, i) =>
      makeFlag({ severity: "info", summary: `info-${i}` }),
    );
    // Input order: infos first, then criticals. After severity sort, criticals come first.
    const input = JSON.stringify([...infos, ...criticals]);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags).toHaveLength(50);
      const kept = result.flags.filter((f) => f.severity === "critical");
      expect(kept).toHaveLength(3);
      expect(result.truncation?.droppedBySeverity.critical).toBe(0);
      expect(result.truncation?.droppedBySeverity.info).toBe(13);
    }
  });

  it("drops warning before critical when both would overflow", () => {
    const criticals = Array.from({ length: 40 }, () =>
      makeFlag({ severity: "critical" }),
    );
    const warnings = Array.from({ length: 20 }, () =>
      makeFlag({ severity: "warning" }),
    );
    const input = JSON.stringify([...warnings, ...criticals]); // 60 total
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.filter((f) => f.severity === "critical")).toHaveLength(40);
      expect(result.flags.filter((f) => f.severity === "warning")).toHaveLength(10);
      expect(result.truncation?.droppedBySeverity.critical).toBe(0);
      expect(result.truncation?.droppedBySeverity.warning).toBe(10);
    }
  });

  it("does not set truncation when at or below the cap", () => {
    const flags = Array.from({ length: 45 }, () => makeFlag());
    const result = validateLLMResponse(JSON.stringify(flags));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncation).toBeUndefined();
      expect(result.flags).toHaveLength(45);
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

  it("warns on suspicious flag count at the threshold boundary", () => {
    // Exactly at threshold should fire (boundary is inclusive).
    const flags = Array.from({ length: SUSPICIOUS_FLAG_THRESHOLD }, () =>
      makeFlag(),
    );
    const input = JSON.stringify(flags);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.some((w) => w.includes("Suspiciously high")),
      ).toBe(true);
    }
  });

  it("does not warn on suspicious flag count just below threshold", () => {
    const flags = Array.from({ length: SUSPICIOUS_FLAG_THRESHOLD - 1 }, () =>
      makeFlag(),
    );
    const input = JSON.stringify(flags);
    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.some((w) => w.includes("Suspiciously high")),
      ).toBe(false);
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

describe("validateLLMResponse — configuration constants", () => {
  it("exposes MAX_FLAGS = 50", () => {
    expect(MAX_FLAGS).toBe(50);
  });

  // Regression guard: SUSPICIOUS_FLAG_THRESHOLD was recalibrated after
  // MAX_FLAGS was raised from 20 -> 50 (issue #511). At MAX_FLAGS=20 the
  // original threshold of 15 sat at 75% of cap ("near-cap" semantics);
  // after the raise to 50 we preserve that ratio at floor(50 * 0.75) = 37.
  it("exposes SUSPICIOUS_FLAG_THRESHOLD = 37 (~75% of MAX_FLAGS)", () => {
    expect(SUSPICIOUS_FLAG_THRESHOLD).toBe(37);
    expect(SUSPICIOUS_FLAG_THRESHOLD).toBe(Math.floor(MAX_FLAGS * 0.75));
  });
});

describe("validateLLMResponse — truncation observability", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The structured logger emits warn-level messages to stderr via console.error
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("emits a structured log when flags exceed MAX_FLAGS", () => {
    const criticals = Array.from({ length: 2 }, () =>
      makeFlag({ severity: "critical" }),
    );
    const warnings = Array.from({ length: 3 }, () =>
      makeFlag({ severity: "warning" }),
    );
    const infos = Array.from({ length: 60 }, () =>
      makeFlag({ severity: "info" }),
    );
    const input = JSON.stringify([...criticals, ...warnings, ...infos]);

    const result = validateLLMResponse(input);

    expect(result.ok).toBe(true);
    // Find the structured truncation log (JSON string via structured logger).
    const structuredCall = errorSpy.mock.calls.find(
      (call) => {
        if (typeof call[0] !== "string") return false;
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.event === "llm_findings_truncated";
        } catch {
          return false;
        }
      },
    );
    expect(structuredCall).toBeDefined();
    const parsed = JSON.parse(structuredCall![0] as string);
    expect(parsed).toMatchObject({
      level: "warn",
      service: "llm-validator",
      event: "llm_findings_truncated",
      received: 65,
      kept: 50,
      dropped: 15,
      droppedBySeverity: {
        critical: 0,
        warning: 0,
        info: 15,
      },
      maxFlags: MAX_FLAGS,
    });
  });

  it("does not emit a truncation log when flags are at or below MAX_FLAGS", () => {
    const flags = Array.from({ length: MAX_FLAGS }, () => makeFlag());
    const result = validateLLMResponse(JSON.stringify(flags));

    expect(result.ok).toBe(true);
    const structuredCall = errorSpy.mock.calls.find(
      (call) => {
        if (typeof call[0] !== "string") return false;
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.event === "llm_findings_truncated";
        } catch {
          return false;
        }
      },
    );
    expect(structuredCall).toBeUndefined();
  });
});
