import { describe, it, expect } from "vitest";
import {
  parseFrequencyText,
  estimateDailyDose,
  FREQUENCY_DOSES_PER_DAY,
  type MedFrequency,
} from "../medication-frequency.js";

describe("parseFrequencyText (#235)", () => {
  const cases: Array<[string, MedFrequency | null]> = [
    // Q-N-hour shorthand
    ["q2h", "q2h"],
    ["Q2H", "q2h"],
    ["q 2 h", "q2h"],
    ["q2hr", "q2h"],
    ["q2hrs", "q2h"],
    ["every 2 hours", "q2h"],
    ["q4h", "q4h"],
    ["Q4H PRN", "q4h"], // paired PRN → keep interval
    ["q6h", "q6h"],
    ["q8h", "q8h"],
    ["q12h", "q12h"],
    ["q24h", "daily"],
    // bid/tid/qid
    ["BID", "bid"],
    ["b.i.d.", "bid"],
    ["twice daily", "bid"],
    ["tid", "tid"],
    ["three times daily", "tid"],
    ["qid", "qid"],
    ["4x/day", "qid"],
    // daily
    ["qd", "daily"],
    ["once daily", "daily"],
    ["once a day", "daily"],
    ["daily", "daily"],
    // PRN standalone
    ["PRN", "prn"],
    ["as needed", "prn"],
    // stat / once
    ["stat", "once"],
    ["once", "once"],
    ["one-time", "once"],
    ["x1", "once"],
    // weekly / monthly
    ["weekly", "weekly"],
    ["q7d", "weekly"],
    ["monthly", "monthly"],
    // uninterpretable
    ["when sleepy", null],
    ["", null],
    ["every 5 hours", null], // non-canonical interval → fail open
    [" ", null],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → ${String(expected)}`, () => {
      expect(parseFrequencyText(input)).toBe(expected);
    });
  }

  it("returns null for null/undefined", () => {
    expect(parseFrequencyText(null)).toBeNull();
    expect(parseFrequencyText(undefined)).toBeNull();
  });
});

describe("FREQUENCY_DOSES_PER_DAY invariants", () => {
  it("q2h gives 12/day, bid 2, tid 3, qid 4", () => {
    expect(FREQUENCY_DOSES_PER_DAY.q2h).toBe(12);
    expect(FREQUENCY_DOSES_PER_DAY.bid).toBe(2);
    expect(FREQUENCY_DOSES_PER_DAY.tid).toBe(3);
    expect(FREQUENCY_DOSES_PER_DAY.qid).toBe(4);
  });

  it("prn contributes 0 by default (caller must supply cap)", () => {
    expect(FREQUENCY_DOSES_PER_DAY.prn).toBe(0);
  });

  it("once contributes 0 (stat isn't a recurring daily load)", () => {
    expect(FREQUENCY_DOSES_PER_DAY.once).toBe(0);
  });

  it("weekly is 1/7, monthly is ~1/30", () => {
    expect(FREQUENCY_DOSES_PER_DAY.weekly).toBeCloseTo(1 / 7);
    expect(FREQUENCY_DOSES_PER_DAY.monthly).toBeCloseTo(1 / 30);
  });
});

describe("estimateDailyDose (#235)", () => {
  it("10 mg morphine q2h → 120 mg/day (respiratory-depression territory)", () => {
    expect(estimateDailyDose(10, "q2h")).toBe(120);
  });

  it("10 mg morphine q4h PRN max 4/day → 40 mg/day (within CDC 90-MME)", () => {
    expect(estimateDailyDose(10, "q4h", 4)).toBe(40);
  });

  it("10 mg morphine q4h (no PRN cap) → 60 mg/day", () => {
    expect(estimateDailyDose(10, "q4h")).toBe(60);
  });

  it("5 mg oxycodone qid → 20 mg/day", () => {
    expect(estimateDailyDose(5, "qid")).toBe(20);
  });

  it("500 mg acetaminophen q6h → 2000 mg/day (half of 4000 mg daily max)", () => {
    expect(estimateDailyDose(500, "q6h")).toBe(2000);
  });

  it("1000 mg acetaminophen q4h → 6000 mg/day (above 4000 mg daily max)", () => {
    expect(estimateDailyDose(1000, "q4h")).toBe(6000);
  });

  it("PRN without max_doses_per_day → null (caller fails open)", () => {
    expect(estimateDailyDose(10, "prn")).toBeNull();
  });

  it("PRN with max_doses_per_day=6 → 6 × dose", () => {
    expect(estimateDailyDose(10, "prn", 6)).toBe(60);
  });

  it("stat / once → null (not a recurring daily load)", () => {
    expect(estimateDailyDose(30, "once")).toBeNull();
  });

  it("null frequency → null", () => {
    expect(estimateDailyDose(10, null)).toBeNull();
  });

  it("zero or negative dose → null", () => {
    expect(estimateDailyDose(0, "q4h")).toBeNull();
    expect(estimateDailyDose(-5, "q4h")).toBeNull();
  });

  it("explicit cap tighter than scheduled frequency wins", () => {
    // q4h is 6/day; cap of 3 overrides.
    expect(estimateDailyDose(10, "q4h", 3)).toBe(30);
  });

  it("explicit cap looser than scheduled frequency is ignored (frequency wins)", () => {
    // q4h is 6/day; cap of 10 doesn't expand the scheduled dose.
    expect(estimateDailyDose(10, "q4h", 10)).toBe(60);
  });
});
