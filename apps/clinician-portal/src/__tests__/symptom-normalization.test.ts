/**
 * Issue #1314 — NS↔ROS auto-mirror normalisation.
 *
 * The first iteration of the auto-mirror used an exact (case-insensitive)
 * suffix match: NS "vision changes" wouldn't auto-mirror to
 * ROS "eyes: vision change" because "changes" !== "change". This is the
 * same plural drift the symptom-suggestion-banner already handles via a
 * naive trailing-"s" strip. Centralising that helper here lets BOTH
 * features share the rule.
 *
 * These tests pin the behaviour:
 *
 *   1. normalizeSymptomLabel lowercases, trims, and strips a single
 *      trailing "s" if present (single-pass; "kiss" stays "kis").
 *      (This matches the deliberately-naive normalisation used in the
 *      banner — we are not trying to be a real stemmer here.)
 *   2. findROSOptionForSymptom returns an EXACT post-normalisation match
 *      ahead of any other candidate, even when multiple suffixes resolve
 *      to the same normalised form.
 *   3. findROSOptionForSymptom returns the first option deterministically
 *      when multiple options normalise to the same value.
 *   4. Distinctive symptoms with no ROS counterpart return undefined.
 *   5. findNSOptionForROS applies the same normalisation symmetrically.
 */
import { describe, it, expect } from "vitest";

import {
  findNSOptionForROS,
  findROSOptionForSymptom,
  normalizeSymptomLabel,
} from "../lib/symptom-normalization";

describe("normalizeSymptomLabel (#1314)", () => {
  it("lowercases and trims", () => {
    expect(normalizeSymptomLabel("  Headache  ")).toBe("headache");
  });

  it("strips a single trailing 's'", () => {
    expect(normalizeSymptomLabel("changes")).toBe("change");
    expect(normalizeSymptomLabel("vision changes")).toBe("vision change");
  });

  it("does not touch words without a trailing 's'", () => {
    expect(normalizeSymptomLabel("headache")).toBe("headache");
    expect(normalizeSymptomLabel("tingling")).toBe("tingling");
  });

  it("strips exactly one trailing 's' per call (single-pass)", () => {
    // We're deliberately non-recursive: "kiss" → "kis" in one pass.
    // The caller is expected to call this helper once per comparison.
    expect(normalizeSymptomLabel("kiss")).toBe("kis");
  });

  it("handles empty / whitespace-only input", () => {
    expect(normalizeSymptomLabel("")).toBe("");
    expect(normalizeSymptomLabel("   ")).toBe("");
  });
});

describe("findROSOptionForSymptom (#1314)", () => {
  const ROS = [
    "constitutional: fever",
    "eyes: vision change",
    "neurological: headache",
    "neurological: vision changes",
    "neurological: dizziness",
  ];

  it("matches a plural NS label to a singular ROS suffix", () => {
    // NS "vision changes" should auto-mirror to ROS "eyes: vision change"
    // once normalisation strips the trailing "s" from both.
    const opt = findROSOptionForSymptom("vision changes", [
      "eyes: vision change",
    ]);
    expect(opt).toBe("eyes: vision change");
  });

  it("matches a singular NS label to a plural ROS suffix", () => {
    const opt = findROSOptionForSymptom("vision change", [
      "neurological: vision changes",
    ]);
    expect(opt).toBe("neurological: vision changes");
  });

  it("returns undefined when no ROS option matches", () => {
    // NS "tingling" has no ROS counterpart in the curated list; we expect
    // a graceful undefined so the auto-mirror simply does nothing.
    expect(findROSOptionForSymptom("tingling", ROS)).toBeUndefined();
  });

  it("prefers an EXACT post-normalisation match over a later partial-normal", () => {
    // Both "eyes: vision change" and "neurological: vision changes"
    // normalise to "vision change". When the NS label "vision change"
    // arrives, the EXACT (no-strip) match should win — `eyes: vision
    // change` is preferred because its suffix already matches without
    // pluralisation surgery.
    const opt = findROSOptionForSymptom("vision change", ROS);
    expect(opt).toBe("eyes: vision change");
  });

  it("returns the first match deterministically when multiple normalise equal", () => {
    // Two ROS options both require an "s"-strip to match "vision changes".
    const tied = [
      "neurological: vision changes",
      "eyes: vision changes",
    ];
    const opt = findROSOptionForSymptom("vision change", tied);
    expect(opt).toBe("neurological: vision changes");
  });

  it("is case-insensitive and trims input", () => {
    const opt = findROSOptionForSymptom("  HEADACHE ", ROS);
    expect(opt).toBe("neurological: headache");
  });
});

describe("findNSOptionForROS (#1314)", () => {
  const NS = ["headache", "vision changes", "tingling", "fever"];

  it("applies the same normalisation in reverse (ROS singular → NS plural)", () => {
    // ROS "eyes: vision change" should resolve back to NS "vision
    // changes".
    const opt = findNSOptionForROS("eyes: vision change", NS);
    expect(opt).toBe("vision changes");
  });

  it("returns undefined when no NS option matches", () => {
    expect(
      findNSOptionForROS("psych: anxiety", NS),
    ).toBeUndefined();
  });

  it("prefers an exact (no-strip) match before falling back to normalisation", () => {
    const tied = ["fever", "fevers"];
    const opt = findNSOptionForROS("constitutional: fever", tied);
    expect(opt).toBe("fever");
  });
});
