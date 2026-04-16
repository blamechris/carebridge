import { describe, it, expect } from "vitest";
import { pickFreshest, mostRecentIso } from "../lib/freshest";

/**
 * Issue #529: StaleDataBanner "most recent" selection used lexicographic
 * string compare on ISO timestamps. Same-instant strings with different
 * suffixes (`Z` vs `+00:00`) or different sub-second precision sort
 * wrong as plain strings. pickFreshest must use Date.parse normalization
 * so the comparison reflects the actual moment in time.
 */
describe("pickFreshest", () => {
  it("selects the later instant regardless of timezone suffix", () => {
    // Same instant: 2026-04-16T15:00:00Z === 2026-04-16T10:00:00-05:00
    // but the `-05:00` variant has a later clock reading, so a naive
    // string compare picks it. Date.parse normalizes both to the same
    // epoch-ms so any deterministic tie-break gives the same result.
    const earlier = { ts: "2026-04-16T09:00:00-05:00" }; // 14:00:00Z
    const later = { ts: "2026-04-16T15:00:00Z" }; // 15:00:00Z
    const pick = pickFreshest([earlier, later], (x) => x.ts);
    expect(pick).toBe(later);
  });

  it("is order-independent — reversing input picks the same winner", () => {
    const earlier = { ts: "2026-04-16T09:00:00-05:00" };
    const later = { ts: "2026-04-16T15:00:00Z" };
    const pick1 = pickFreshest([earlier, later], (x) => x.ts);
    const pick2 = pickFreshest([later, earlier], (x) => x.ts);
    expect(pick1).toBe(later);
    expect(pick2).toBe(later);
  });

  it("treats Z and +00:00 at the same instant as equivalent", () => {
    // Both strings are the same UTC instant. The helper should not
    // prefer one format over the other; the first (stable) encounter
    // wins.
    const a = { ts: "2026-04-16T10:00:00Z" };
    const b = { ts: "2026-04-16T10:00:00+00:00" };
    expect(pickFreshest([a, b], (x) => x.ts)).toBe(a);
    expect(pickFreshest([b, a], (x) => x.ts)).toBe(b);
  });

  it("treats Z and .000Z at the same instant as equivalent", () => {
    // Sub-second precision drift: `10:00:00Z` vs `10:00:00.000Z`.
    // Lexicographic compare would pick `10:00:00.000Z` as "later"
    // because '.' > 'Z' is false but '.000Z' > 'Z' is string-wise
    // tricky. Epoch-ms normalization makes them equal.
    const a = { ts: "2026-04-16T10:00:00Z" };
    const b = { ts: "2026-04-16T10:00:00.000Z" };
    expect(pickFreshest([a, b], (x) => x.ts)).toBe(a);
    expect(pickFreshest([b, a], (x) => x.ts)).toBe(b);
  });

  it("skips unparseable and nullish timestamps", () => {
    const good = { ts: "2026-04-16T10:00:00Z" };
    const nullish = { ts: null };
    const junk = { ts: "not-a-date" };
    const pick = pickFreshest([nullish, junk, good], (x) => x.ts);
    expect(pick).toBe(good);
  });

  it("returns null for empty input", () => {
    expect(pickFreshest([], (x: unknown) => String(x))).toBeNull();
  });

  it("returns null when every timestamp is unparseable", () => {
    expect(
      pickFreshest([{ ts: null }, { ts: undefined }, { ts: "bad" }], (x) => x.ts),
    ).toBeNull();
  });
});

describe("mostRecentIso", () => {
  it("returns the freshest ISO string from a mixed list", () => {
    const values = [
      "2026-04-16T09:00:00-05:00", // 14:00:00Z
      "2026-04-16T15:00:00Z",
      "2026-04-16T10:00:00Z",
    ];
    expect(mostRecentIso(values)).toBe("2026-04-16T15:00:00Z");
  });

  it("skips null/undefined/junk entries", () => {
    const values = [null, undefined, "bad", "2026-04-16T12:00:00Z"];
    expect(mostRecentIso(values)).toBe("2026-04-16T12:00:00Z");
  });

  it("returns null when there are no parseable entries", () => {
    expect(mostRecentIso([])).toBeNull();
    expect(mostRecentIso([null, undefined, ""])).toBeNull();
  });
});
