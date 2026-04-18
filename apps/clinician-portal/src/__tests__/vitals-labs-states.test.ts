import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pickFreshest, mostRecentIso } from "../lib/freshest.js";

// ---------------------------------------------------------------------------
// Issue #531 — VitalsTab / LabsTab empty, stale, and current state logic
//
// These tests exercise the pure staleness-detection logic extracted from
// the VitalsTab and LabsTab components in app/patients/[id]/page.tsx.
// The component uses:
//   - pickFreshest / mostRecentIso  to find the newest record
//   - `Date.now() - Date.parse(ts) > STALE_THRESHOLD_MS` to decide banner
//   - Labs: `collected_at ?? created_at` for date selection
// ---------------------------------------------------------------------------

/** Mirrors STALE_THRESHOLD_MS in page.tsx */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Reproduce the vitals staleness check from VitalsTab */
function vitalsIsStale(
  latest: Array<{ recorded_at: string }>,
): { isEmpty: boolean; isStale: boolean; freshnessUnknown: boolean } {
  if (latest.length === 0) {
    return { isEmpty: true, isStale: false, freshnessUnknown: false };
  }
  const mostRecent = pickFreshest(latest, (v) => v.recorded_at);
  const freshnessUnknown = mostRecent === null && latest.length > 0;
  const isStale =
    freshnessUnknown ||
    (mostRecent !== null &&
      Date.now() - new Date(mostRecent.recorded_at).getTime() >
        STALE_THRESHOLD_MS);
  return { isEmpty: false, isStale, freshnessUnknown };
}

/** Reproduce the labs staleness check from LabsTab */
function labsIsStale(
  panels: Array<{
    panel: { collected_at: string | null; created_at: string };
  }>,
): { isEmpty: boolean; isStale: boolean } {
  if (panels.length === 0) {
    return { isEmpty: true, isStale: false };
  }
  const mostRecentPanelAt = mostRecentIso(
    panels.map((p) => p.panel.collected_at ?? p.panel.created_at),
  );
  const isStale =
    mostRecentPanelAt !== null &&
    Date.now() - new Date(mostRecentPanelAt).getTime() > STALE_THRESHOLD_MS;
  return { isEmpty: false, isStale };
}

// ---------------------------------------------------------------------------
// Freeze time for deterministic assertions
// ---------------------------------------------------------------------------

const NOW = new Date("2026-04-17T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// VitalsTab states
// ---------------------------------------------------------------------------

describe("VitalsTab state logic", () => {
  it("empty state: no records yields isEmpty=true", () => {
    const result = vitalsIsStale([]);
    expect(result.isEmpty).toBe(true);
    expect(result.isStale).toBe(false);
  });

  it("stale state: freshest record > 7 days ago yields isStale=true", () => {
    const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = vitalsIsStale([{ recorded_at: eightDaysAgo }]);
    expect(result.isEmpty).toBe(false);
    expect(result.isStale).toBe(true);
  });

  it("current state: record within 7 days yields isStale=false", () => {
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = vitalsIsStale([{ recorded_at: twoDaysAgo }]);
    expect(result.isEmpty).toBe(false);
    expect(result.isStale).toBe(false);
  });

  it("boundary: exactly 7 days old is NOT stale (> comparison)", () => {
    const exactlySevenDays = new Date(NOW - STALE_THRESHOLD_MS).toISOString();
    const result = vitalsIsStale([{ recorded_at: exactlySevenDays }]);
    expect(result.isEmpty).toBe(false);
    expect(result.isStale).toBe(false);
  });

  it("stale state: one millisecond past 7 days is stale", () => {
    const justPastSeven = new Date(
      NOW - STALE_THRESHOLD_MS - 1,
    ).toISOString();
    const result = vitalsIsStale([{ recorded_at: justPastSeven }]);
    expect(result.isStale).toBe(true);
  });

  it("freshness unknown: unparseable timestamps with data present", () => {
    const result = vitalsIsStale([{ recorded_at: "not-a-date" }]);
    expect(result.freshnessUnknown).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("picks the freshest among multiple records for staleness", () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
    const result = vitalsIsStale([
      { recorded_at: tenDaysAgo },
      { recorded_at: oneDayAgo },
    ]);
    // The freshest is 1 day ago, so not stale
    expect(result.isStale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LabsTab states
// ---------------------------------------------------------------------------

describe("LabsTab state logic", () => {
  it("empty state: no panels yields isEmpty=true", () => {
    const result = labsIsStale([]);
    expect(result.isEmpty).toBe(true);
    expect(result.isStale).toBe(false);
  });

  it("stale state: freshest panel > 7 days ago yields isStale=true", () => {
    const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = labsIsStale([
      { panel: { collected_at: eightDaysAgo, created_at: eightDaysAgo } },
    ]);
    expect(result.isStale).toBe(true);
  });

  it("current state: panel within 7 days yields isStale=false", () => {
    const threeDaysAgo = new Date(
      NOW - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = labsIsStale([
      { panel: { collected_at: threeDaysAgo, created_at: threeDaysAgo } },
    ]);
    expect(result.isStale).toBe(false);
  });

  it("boundary: exactly 7 days old is NOT stale (> comparison)", () => {
    const exactlySevenDays = new Date(NOW - STALE_THRESHOLD_MS).toISOString();
    const result = labsIsStale([
      {
        panel: {
          collected_at: exactlySevenDays,
          created_at: exactlySevenDays,
        },
      },
    ]);
    expect(result.isStale).toBe(false);
  });

  it("uses collected_at when available", () => {
    const oneDayAgo = new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    // collected_at is recent, created_at is old — should use collected_at
    const result = labsIsStale([
      { panel: { collected_at: oneDayAgo, created_at: tenDaysAgo } },
    ]);
    expect(result.isStale).toBe(false);
  });

  it("falls back to created_at when collected_at is null", () => {
    const oneDayAgo = new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
    const result = labsIsStale([
      { panel: { collected_at: null, created_at: oneDayAgo } },
    ]);
    expect(result.isStale).toBe(false);
  });

  it("falls back to created_at (stale) when collected_at is null", () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const result = labsIsStale([
      { panel: { collected_at: null, created_at: tenDaysAgo } },
    ]);
    expect(result.isStale).toBe(true);
  });

  it("picks the freshest panel across multiple panels", () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = labsIsStale([
      { panel: { collected_at: tenDaysAgo, created_at: tenDaysAgo } },
      { panel: { collected_at: twoDaysAgo, created_at: twoDaysAgo } },
    ]);
    expect(result.isStale).toBe(false);
  });

  it("mixed null collected_at: uses created_at for fallback panels", () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
    // First panel: collected_at is null, created_at is old
    // Second panel: collected_at is null, created_at is recent
    const result = labsIsStale([
      { panel: { collected_at: null, created_at: tenDaysAgo } },
      { panel: { collected_at: null, created_at: oneDayAgo } },
    ]);
    expect(result.isStale).toBe(false);
  });
});
