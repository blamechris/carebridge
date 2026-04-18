import { describe, it, expect } from "vitest";
import type { LabFlag } from "@carebridge/shared-types";
import {
  isOutOfRange,
  labValueColor,
  deriveInferredFlag,
} from "../lib/lab-display.js";
import {
  formatReferenceRange,
  RANGE_SEPARATOR,
  NO_VALUE,
} from "../lib/formatting.js";

// ---------------------------------------------------------------------------
// Issue #543 — LabsTab reference-range and inferred-flag logic
// ---------------------------------------------------------------------------

describe("isOutOfRange", () => {
  it("returns true when value < refLow", () => {
    expect(isOutOfRange(3.2, 3.5, 5.0)).toBe(true);
  });

  it("returns true when value > refHigh", () => {
    expect(isOutOfRange(5.5, 3.5, 5.0)).toBe(true);
  });

  it("returns false when value is within range", () => {
    expect(isOutOfRange(4.0, 3.5, 5.0)).toBe(false);
  });

  it("returns false when value equals refLow (boundary)", () => {
    expect(isOutOfRange(3.5, 3.5, 5.0)).toBe(false);
  });

  it("returns false when value equals refHigh (boundary)", () => {
    expect(isOutOfRange(5.0, 3.5, 5.0)).toBe(false);
  });

  it("returns false for non-numeric value", () => {
    expect(isOutOfRange("high" as unknown, 3.5, 5.0)).toBe(false);
  });

  it("handles missing refLow (only high bound)", () => {
    expect(isOutOfRange(5.5, null, 5.0)).toBe(true);
    expect(isOutOfRange(4.0, null, 5.0)).toBe(false);
  });

  it("handles missing refHigh (only low bound)", () => {
    expect(isOutOfRange(3.2, 3.5, null)).toBe(true);
    expect(isOutOfRange(4.0, 3.5, null)).toBe(false);
  });

  it("returns false when both bounds are missing", () => {
    expect(isOutOfRange(4.0, null, null)).toBe(false);
  });
});

describe("labValueColor", () => {
  it("returns critical colour for server flag 'critical'", () => {
    expect(labValueColor("critical", false)).toBe("var(--critical)");
    // critical flag takes precedence even if not out of range
    expect(labValueColor("critical", true)).toBe("var(--critical)");
  });

  it("returns warning colour for server flag 'H'", () => {
    expect(labValueColor("H", false)).toBe("var(--warning)");
  });

  it("returns warning colour for server flag 'L'", () => {
    expect(labValueColor("L", false)).toBe("var(--warning)");
  });

  it("returns warning colour for out-of-range with no server flag", () => {
    expect(labValueColor("", true)).toBe("var(--warning)");
    expect(labValueColor(undefined, true)).toBe("var(--warning)");
    expect(labValueColor(null, true)).toBe("var(--warning)");
  });

  it("returns default colour when in range and no flag", () => {
    expect(labValueColor("", false)).toBe("var(--text-primary)");
    expect(labValueColor(undefined, false)).toBe("var(--text-primary)");
  });

  // --- Issue #795: expanded labValueColor coverage ---

  it("returns warning colour for lowercase short flags 'h' and 'l'", () => {
    expect(labValueColor("h" as LabFlag, false)).toBe("var(--warning)");
    expect(labValueColor("l" as LabFlag, false)).toBe("var(--warning)");
  });

  it("returns warning colour for long-form flags 'high' and 'low'", () => {
    expect(labValueColor("high" as LabFlag, false)).toBe("var(--warning)");
    expect(labValueColor("low" as LabFlag, false)).toBe("var(--warning)");
  });

  it("returns warning colour for uppercase long-form flag 'HIGH'", () => {
    expect(labValueColor("HIGH" as LabFlag, false)).toBe("var(--warning)");
  });

  it("returns warning colour for mixed-case long-form flags", () => {
    expect(labValueColor("High" as LabFlag, false)).toBe("var(--warning)");
    expect(labValueColor("Low" as LabFlag, false)).toBe("var(--warning)");
    expect(labValueColor("LOW" as LabFlag, false)).toBe("var(--warning)");
  });

  it("returns critical colour for 'critical' in all casings", () => {
    expect(labValueColor("critical" as LabFlag, false)).toBe("var(--critical)");
    expect(labValueColor("CRITICAL" as LabFlag, false)).toBe("var(--critical)");
    expect(labValueColor("Critical" as LabFlag, false)).toBe("var(--critical)");
  });

  it("returns default colour for null flag with outOfRange=false", () => {
    expect(labValueColor(null, false)).toBe("var(--text-primary)");
  });

  it("returns default colour for undefined flag with outOfRange=false", () => {
    expect(labValueColor(undefined, false)).toBe("var(--text-primary)");
  });

  it("returns default colour for empty string flag with outOfRange=false", () => {
    expect(labValueColor("", false)).toBe("var(--text-primary)");
  });

  it("server flag 'H' takes precedence over outOfRange=false", () => {
    // flag present but outOfRange is false — flag wins
    expect(labValueColor("H", false)).toBe("var(--warning)");
  });

  it("server flag takes precedence over client outOfRange", () => {
    // critical flag + outOfRange=true → critical (not warning)
    expect(labValueColor("critical", true)).toBe("var(--critical)");
    // H flag + outOfRange=true → warning (flag matched, not fallthrough)
    expect(labValueColor("H", true)).toBe("var(--warning)");
    // H flag + outOfRange=false → warning (flag alone sufficient)
    expect(labValueColor("H", false)).toBe("var(--warning)");
  });
});

describe("deriveInferredFlag", () => {
  // K+ 3.2 with ref 3.5–5.0, no server flag → LOW inferred
  it("infers 'low' when value < refLow and no server flag", () => {
    expect(deriveInferredFlag(3.2, "", 3.5, 5.0)).toBe("low");
  });

  // K+ 5.5 with ref 3.5–5.0, no server flag → HIGH inferred
  it("infers 'high' when value > refHigh and no server flag", () => {
    expect(deriveInferredFlag(5.5, "", 3.5, 5.0)).toBe("high");
  });

  // K+ 2.5 with server flag="critical" → no inferred flag
  it("returns '' when server already provides a flag", () => {
    expect(deriveInferredFlag(2.5, "critical", 3.5, 5.0)).toBe("");
    expect(deriveInferredFlag(2.5, "L", 3.5, 5.0)).toBe("");
    expect(deriveInferredFlag(5.5, "H", 3.5, 5.0)).toBe("");
  });

  // K+ 4.0 in range → no inferred flag
  it("returns '' when value is within range", () => {
    expect(deriveInferredFlag(4.0, "", 3.5, 5.0)).toBe("");
  });

  it("returns '' for non-numeric value", () => {
    expect(deriveInferredFlag("high" as unknown, "", 3.5, 5.0)).toBe("");
  });

  it("returns '' when both bounds are missing", () => {
    expect(deriveInferredFlag(4.0, "", null, null)).toBe("");
  });
});

describe("formatReferenceRange (labs-tab scenarios)", () => {
  // {low, high} → "3.5–5.0"
  it("formats both bounds as low–high", () => {
    const result = formatReferenceRange(3.5, 5.0);
    expect(result).toBe(`3.5${RANGE_SEPARATOR}5`);
  });

  // {low only} → "> 3.5"
  it("formats low-only as '> low'", () => {
    expect(formatReferenceRange(3.5, null)).toBe("> 3.5");
  });

  // {high only} → "< 5.0"
  it("formats high-only as '< high'", () => {
    expect(formatReferenceRange(null, 5.0)).toBe("< 5");
  });

  // {neither} → "—" (em-dash)
  it("formats missing bounds as em-dash", () => {
    expect(formatReferenceRange(null, null)).toBe(NO_VALUE);
  });
});

describe("end-to-end lab scenarios from issue #543", () => {
  it("K+ 3.2, ref 3.5–5.0, no server flag → warning colour, LOW inferred", () => {
    const value = 3.2;
    const flag = "" as const;
    const refLow = 3.5;
    const refHigh = 5.0;

    const outOfRange = isOutOfRange(value, refLow, refHigh);
    expect(outOfRange).toBe(true);

    const colour = labValueColor(flag, outOfRange);
    expect(colour).toBe("var(--warning)");

    const inferred = deriveInferredFlag(value, flag, refLow, refHigh);
    expect(inferred).toBe("low");
  });

  it("K+ 5.5, ref 3.5–5.0, no server flag → warning colour, HIGH inferred", () => {
    const value = 5.5;
    const flag = "" as const;
    const refLow = 3.5;
    const refHigh = 5.0;

    const outOfRange = isOutOfRange(value, refLow, refHigh);
    expect(outOfRange).toBe(true);

    const colour = labValueColor(flag, outOfRange);
    expect(colour).toBe("var(--warning)");

    const inferred = deriveInferredFlag(value, flag, refLow, refHigh);
    expect(inferred).toBe("high");
  });

  it("K+ 2.5, server flag='critical' → critical colour, CRITICAL badge, no inferred", () => {
    const value = 2.5;
    const flag = "critical" as const;
    const refLow = 3.5;
    const refHigh = 5.0;

    const outOfRange = isOutOfRange(value, refLow, refHigh);
    expect(outOfRange).toBe(true);

    const colour = labValueColor(flag, outOfRange);
    expect(colour).toBe("var(--critical)");

    const inferred = deriveInferredFlag(value, flag, refLow, refHigh);
    expect(inferred).toBe("");
  });

  it("K+ 4.0, in range → default colour, no badge", () => {
    const value = 4.0;
    const flag = "" as const;
    const refLow = 3.5;
    const refHigh = 5.0;

    const outOfRange = isOutOfRange(value, refLow, refHigh);
    expect(outOfRange).toBe(false);

    const colour = labValueColor(flag, outOfRange);
    expect(colour).toBe("var(--text-primary)");

    const inferred = deriveInferredFlag(value, flag, refLow, refHigh);
    expect(inferred).toBe("");
  });
});
