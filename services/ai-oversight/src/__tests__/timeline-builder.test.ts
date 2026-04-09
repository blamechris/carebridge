import { describe, it, expect } from "vitest";
import {
  assembleTimeline,
  detectTemporalClusters,
  detectGaps,
  TIMELINE_WINDOW_DAYS,
  SAME_DAY_CLUSTER_THRESHOLD,
  SAME_WEEK_CLUSTER_THRESHOLD,
  STALE_VITALS_DAYS,
  STALE_NOTE_DAYS,
  type TimelineInputs,
} from "../workers/timeline-builder.js";
import type { TimelineEvent } from "@carebridge/ai-prompts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-04-09T12:00:00.000Z";

function daysAgo(days: number, hours = 12): string {
  const base = Date.parse(NOW);
  const t = base - days * 24 * 60 * 60 * 1000 + hours * 60 * 60 * 1000;
  return new Date(t).toISOString();
}

const EMPTY_INPUTS: TimelineInputs = {
  vitals: [],
  lab_panels: [],
  medications: [],
  notes: [],
  encounters: [],
};

// ---------------------------------------------------------------------------
// assembleTimeline
// ---------------------------------------------------------------------------

describe("assembleTimeline", () => {
  it("returns an empty array when all inputs are empty", () => {
    expect(assembleTimeline(EMPTY_INPUTS, NOW)).toEqual([]);
  });

  it("folds vitals into the timeline with formatted detail", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        vitals: [
          {
            recorded_at: daysAgo(2),
            type: "heart_rate",
            value_primary: 88,
            unit: "bpm",
          },
        ],
      },
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("vital");
    expect(result[0].detail).toBe("heart_rate: 88 bpm");
  });

  it("drops events outside the 30-day window", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        vitals: [
          {
            recorded_at: daysAgo(TIMELINE_WINDOW_DAYS + 5),
            type: "heart_rate",
            value_primary: 72,
            unit: "bpm",
          },
          {
            recorded_at: daysAgo(5),
            type: "heart_rate",
            value_primary: 74,
            unit: "bpm",
          },
        ],
      },
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0].at).toBe(daysAgo(5));
  });

  it("sorts events chronologically oldest → newest", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        vitals: [
          {
            recorded_at: daysAgo(1),
            type: "heart_rate",
            value_primary: 90,
            unit: "bpm",
          },
          {
            recorded_at: daysAgo(10),
            type: "heart_rate",
            value_primary: 72,
            unit: "bpm",
          },
          {
            recorded_at: daysAgo(5),
            type: "heart_rate",
            value_primary: 85,
            unit: "bpm",
          },
        ],
      },
      NOW,
    );

    expect(result.map((e) => e.at)).toEqual([
      daysAgo(10),
      daysAgo(5),
      daysAgo(1),
    ]);
  });

  it("marks lab panels with abnormal results as warning severity", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        lab_panels: [
          {
            collected_at: daysAgo(3),
            panel_name: "CBC",
            abnormal_count: 2,
          },
          {
            collected_at: daysAgo(4),
            panel_name: "BMP",
            abnormal_count: 0,
          },
        ],
      },
      NOW,
    );

    const cbc = result.find((e) => e.detail.startsWith("CBC"))!;
    const bmp = result.find((e) => e.detail.startsWith("BMP"))!;
    expect(cbc.severity).toBe("warning");
    expect(cbc.detail).toBe("CBC (2 abnormal)");
    expect(bmp.severity).toBeUndefined();
    expect(bmp.detail).toBe("BMP");
  });

  it("handles notes with null signed_at by falling back to created_at", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        notes: [
          {
            created_at: daysAgo(5),
            signed_at: null,
            template_type: "soap",
            status: "draft",
          },
        ],
      },
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0].at).toBe(daysAgo(5));
    expect(result[0].detail).toBe("soap draft");
  });

  it("prefers signed_at over created_at when both are present", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        notes: [
          {
            created_at: daysAgo(6),
            signed_at: daysAgo(5),
            template_type: "progress",
            status: "signed",
          },
        ],
      },
      NOW,
    );

    expect(result[0].at).toBe(daysAgo(5));
  });

  it("folds encounters with reason into the detail", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        encounters: [
          {
            start_time: daysAgo(2),
            encounter_type: "emergency",
            reason: "chest pain",
          },
        ],
      },
      NOW,
    );

    expect(result[0].category).toBe("encounter");
    expect(result[0].detail).toBe("emergency — chest pain");
  });

  it("omits medications with null started_at (they are out of window)", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        medications: [
          {
            started_at: null,
            name: "aspirin",
            dose_amount: 81,
            dose_unit: "mg",
            status: "active",
          },
        ],
      },
      NOW,
    );
    expect(result).toEqual([]);
  });

  it("drops events with unparseable timestamps", () => {
    const result = assembleTimeline(
      {
        ...EMPTY_INPUTS,
        vitals: [
          {
            recorded_at: "not a date",
            type: "heart_rate",
            value_primary: 72,
            unit: "bpm",
          },
        ],
      },
      NOW,
    );
    expect(result).toEqual([]);
  });

  it("combines every modality into a single sorted stream", () => {
    const result = assembleTimeline(
      {
        vitals: [
          {
            recorded_at: daysAgo(10),
            type: "heart_rate",
            value_primary: 75,
            unit: "bpm",
          },
        ],
        lab_panels: [
          {
            collected_at: daysAgo(8),
            panel_name: "CMP",
            abnormal_count: 0,
          },
        ],
        medications: [
          {
            started_at: daysAgo(6),
            name: "metoprolol",
            dose_amount: 25,
            dose_unit: "mg",
            status: "active",
          },
        ],
        notes: [
          {
            created_at: daysAgo(4),
            signed_at: daysAgo(4),
            template_type: "soap",
            status: "signed",
          },
        ],
        encounters: [
          {
            start_time: daysAgo(2),
            encounter_type: "outpatient",
            reason: "follow-up",
          },
        ],
      },
      NOW,
    );

    expect(result.map((e) => e.category)).toEqual([
      "vital",
      "lab",
      "medication",
      "note",
      "encounter",
    ]);
  });
});

// ---------------------------------------------------------------------------
// detectTemporalClusters
// ---------------------------------------------------------------------------

describe("detectTemporalClusters", () => {
  function mkEvent(
    at: string,
    category: TimelineEvent["category"] = "vital",
  ): TimelineEvent {
    return { at, category, detail: "test" };
  }

  it("returns no clusters for an empty timeline", () => {
    expect(detectTemporalClusters([])).toEqual([]);
  });

  it("returns no clusters when every day is below the threshold", () => {
    const timeline = [
      mkEvent(daysAgo(1)),
      mkEvent(daysAgo(3)),
      mkEvent(daysAgo(10)),
    ];
    expect(detectTemporalClusters(timeline)).toEqual([]);
  });

  it("detects a same-day cluster when threshold is met", () => {
    const day = daysAgo(5);
    // Three distinct timestamps on the same day.
    const timeline = [
      { at: day.slice(0, 10) + "T08:00:00.000Z", category: "vital", detail: "a" },
      { at: day.slice(0, 10) + "T10:00:00.000Z", category: "lab", detail: "b" },
      { at: day.slice(0, 10) + "T14:00:00.000Z", category: "note", detail: "c" },
    ] as TimelineEvent[];

    const clusters = detectTemporalClusters(timeline);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].window).toBe("same_day");
    expect(clusters[0].event_count).toBe(SAME_DAY_CLUSTER_THRESHOLD);
    expect(clusters[0].categories).toEqual(["vital", "lab", "note"]);
    expect(clusters[0].start).toContain("T08:00:00");
    expect(clusters[0].end).toContain("T14:00:00");
  });

  it("detects a same-week cluster when events span several days", () => {
    const timeline: TimelineEvent[] = [
      { at: daysAgo(10), category: "vital", detail: "a" },
      { at: daysAgo(9), category: "lab", detail: "b" },
      { at: daysAgo(8), category: "medication", detail: "c" },
      { at: daysAgo(7), category: "note", detail: "d" },
      { at: daysAgo(6), category: "encounter", detail: "e" },
    ];

    const clusters = detectTemporalClusters(timeline);
    const weekClusters = clusters.filter((c) => c.window === "same_week");
    expect(weekClusters.length).toBeGreaterThanOrEqual(1);
    expect(weekClusters[0].event_count).toBeGreaterThanOrEqual(
      SAME_WEEK_CLUSTER_THRESHOLD,
    );
  });

  it("does not report a same-week cluster when it fully overlaps a same-day cluster", () => {
    // Five events, all same day — same-day cluster wins, same-week
    // must not double-report the same burst.
    const day = daysAgo(5).slice(0, 10);
    const timeline: TimelineEvent[] = Array.from({ length: 5 }, (_, i) => ({
      at: `${day}T${String(8 + i).padStart(2, "0")}:00:00.000Z`,
      category: "vital",
      detail: `v${i}`,
    }));

    const clusters = detectTemporalClusters(timeline);
    expect(clusters.filter((c) => c.window === "same_week")).toEqual([]);
    expect(clusters.filter((c) => c.window === "same_day")).toHaveLength(1);
  });

  it("dedupes categories in the cluster summary", () => {
    const day = daysAgo(3).slice(0, 10);
    const timeline: TimelineEvent[] = [
      { at: `${day}T08:00:00.000Z`, category: "vital", detail: "a" },
      { at: `${day}T09:00:00.000Z`, category: "vital", detail: "b" },
      { at: `${day}T10:00:00.000Z`, category: "vital", detail: "c" },
    ];
    const clusters = detectTemporalClusters(timeline);
    expect(clusters[0].categories).toEqual(["vital"]);
  });
});

// ---------------------------------------------------------------------------
// detectGaps
// ---------------------------------------------------------------------------

describe("detectGaps", () => {
  it("returns no gaps when vitals and notes are fresh", () => {
    const gaps = detectGaps(
      {
        active_diagnoses_count: 2,
        latest_vital_at: daysAgo(1),
        latest_note_at: daysAgo(3),
      },
      NOW,
    );
    expect(gaps).toEqual([]);
  });

  it("flags stale vitals when older than the threshold", () => {
    const gaps = detectGaps(
      {
        active_diagnoses_count: 1,
        latest_vital_at: daysAgo(STALE_VITALS_DAYS + 2),
        latest_note_at: daysAgo(2),
      },
      NOW,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].description).toMatch(/No vitals recorded in/);
    expect(gaps[0].severity).toBe("warning");
  });

  it("does not flag stale vitals just inside the threshold", () => {
    const gaps = detectGaps(
      {
        active_diagnoses_count: 1,
        latest_vital_at: daysAgo(STALE_VITALS_DAYS - 1),
        latest_note_at: daysAgo(2),
      },
      NOW,
    );
    expect(gaps).toEqual([]);
  });

  it("flags a total absence of vitals when the patient has active diagnoses", () => {
    const gaps = detectGaps(
      {
        active_diagnoses_count: 3,
        latest_vital_at: null,
        latest_note_at: daysAgo(5),
      },
      NOW,
    );
    expect(gaps.some((g) => g.description.includes("No vitals on record"))).toBe(
      true,
    );
  });

  it("does not flag missing vitals for a patient with no active diagnoses", () => {
    const gaps = detectGaps(
      {
        active_diagnoses_count: 0,
        latest_vital_at: null,
        latest_note_at: null,
      },
      NOW,
    );
    expect(gaps).toEqual([]);
  });

  it("flags stale notes only when there are active diagnoses", () => {
    const withDx = detectGaps(
      {
        active_diagnoses_count: 2,
        latest_vital_at: daysAgo(2),
        latest_note_at: daysAgo(STALE_NOTE_DAYS + 5),
      },
      NOW,
    );
    expect(
      withDx.some((g) => g.description.includes("No clinical note")),
    ).toBe(true);
    expect(
      withDx.find((g) => g.description.includes("No clinical note"))?.severity,
    ).toBe("info");

    const withoutDx = detectGaps(
      {
        active_diagnoses_count: 0,
        latest_vital_at: daysAgo(2),
        latest_note_at: daysAgo(STALE_NOTE_DAYS + 5),
      },
      NOW,
    );
    expect(
      withoutDx.some((g) => g.description.includes("No clinical note")),
    ).toBe(false);
  });
});
