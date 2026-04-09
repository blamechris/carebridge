import { describe, it, expect } from "vitest";
import {
  buildReviewPrompt,
  type ReviewContext,
  type TimelineEvent,
  type TemporalCluster,
  type GapDetected,
} from "../clinical-review.js";
import { PROMPT_SECTIONS } from "../prompt-sections.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    patient: {
      age: 67,
      sex: "female",
      active_diagnoses: ["Breast cancer (metastatic)", "DVT — left leg"],
      allergies: ["penicillin"],
    },
    active_medications: [
      {
        name: "enoxaparin",
        dose: "80 mg",
        route: "SC",
        frequency: "BID",
        started_at: "2026-03-10T00:00:00.000Z",
      },
    ],
    latest_vitals: {
      heart_rate: {
        value: 92,
        unit: "bpm",
        recorded_at: "2026-04-08T12:00:00.000Z",
        trend: "rising",
      },
    },
    recent_labs: [
      {
        test_name: "INR",
        value: 2.4,
        unit: "",
        flag: null,
        collected_at: "2026-04-07T00:00:00.000Z",
      },
    ],
    triggering_event: {
      type: "vital.created",
      summary: "New headache reported",
      detail: "<untrusted_event_data>{}</untrusted_event_data>",
    },
    recent_flags: [],
    care_team: [
      { name: "Dr. Smith", specialty: "Hematology/Oncology" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Legacy parity — without Phase A3 fields the prompt should be stable
// ---------------------------------------------------------------------------

describe("buildReviewPrompt — legacy baseline", () => {
  it("does not render timeline/cluster/gap sections when they are absent", () => {
    const prompt = buildReviewPrompt(baseContext());

    expect(prompt).not.toContain(PROMPT_SECTIONS.TIMELINE);
    expect(prompt).not.toContain(PROMPT_SECTIONS.CLUSTERS);
    expect(prompt).not.toContain(PROMPT_SECTIONS.GAPS);
  });

  it("still renders the core sections", () => {
    const prompt = buildReviewPrompt(baseContext());

    expect(prompt).toContain(PROMPT_SECTIONS.DEMOGRAPHICS);
    expect(prompt).toContain(PROMPT_SECTIONS.DIAGNOSES);
    expect(prompt).toContain(PROMPT_SECTIONS.MEDICATIONS);
    expect(prompt).toContain("67 year old female");
    expect(prompt).toContain("enoxaparin");
    expect(prompt).toContain("Dr. Smith");
  });

  it("omits the timeline block when an empty array is passed", () => {
    const prompt = buildReviewPrompt(
      baseContext({
        timeline_30d: [],
        temporal_clusters: [],
        gaps_detected: [],
      }),
    );
    expect(prompt).not.toContain(PROMPT_SECTIONS.TIMELINE);
    expect(prompt).not.toContain(PROMPT_SECTIONS.CLUSTERS);
    expect(prompt).not.toContain(PROMPT_SECTIONS.GAPS);
  });
});

// ---------------------------------------------------------------------------
// Phase A3 — timeline / clusters / gaps rendering
// ---------------------------------------------------------------------------

describe("buildReviewPrompt — Phase A3 sections", () => {
  const timeline: TimelineEvent[] = [
    {
      at: "2026-03-15T09:00:00.000Z",
      category: "encounter",
      detail: "emergency — chest pain",
    },
    {
      at: "2026-03-15T11:00:00.000Z",
      category: "lab",
      detail: "Troponin (1 abnormal)",
      severity: "warning",
    },
    {
      at: "2026-04-01T08:30:00.000Z",
      category: "note",
      detail: "soap signed",
      specialty: "Cardiology",
    },
  ];
  const clusters: TemporalCluster[] = [
    {
      window: "same_day",
      start: "2026-03-15T09:00:00.000Z",
      end: "2026-03-15T11:00:00.000Z",
      event_count: 2,
      categories: ["encounter", "lab"],
      summary: "2 events on 2026-03-15",
    },
  ];
  const gaps: GapDetected[] = [
    {
      description: "No vitals recorded in 15 days",
      since: "2026-03-25T00:00:00.000Z",
      severity: "warning",
    },
  ];

  it("renders the TIMELINE section with each event on its own line", () => {
    const prompt = buildReviewPrompt(
      baseContext({ timeline_30d: timeline }),
    );

    expect(prompt).toContain(`${PROMPT_SECTIONS.TIMELINE}:`);
    expect(prompt).toContain("2026-03-15T09:00:00.000Z encounter");
    expect(prompt).toContain("emergency — chest pain");
    expect(prompt).toContain("Troponin (1 abnormal)");
    expect(prompt).toContain("(Cardiology)");
    expect(prompt).toContain("[warning]");
  });

  it("renders the CLUSTERS section with window label and category list", () => {
    const prompt = buildReviewPrompt(
      baseContext({
        timeline_30d: timeline,
        temporal_clusters: clusters,
      }),
    );

    expect(prompt).toContain(`${PROMPT_SECTIONS.CLUSTERS}:`);
    expect(prompt).toContain("[same_day]");
    expect(prompt).toContain("2 events");
    expect(prompt).toContain("encounter, lab");
  });

  it("renders the GAPS section with severity markers", () => {
    const prompt = buildReviewPrompt(
      baseContext({
        gaps_detected: gaps,
      }),
    );

    expect(prompt).toContain(`${PROMPT_SECTIONS.GAPS}:`);
    expect(prompt).toContain("[warning] No vitals recorded in 15 days");
  });

  it("keeps the TRIGGERING_EVENT section last for LLM focus", () => {
    const prompt = buildReviewPrompt(
      baseContext({
        timeline_30d: timeline,
        temporal_clusters: clusters,
        gaps_detected: gaps,
      }),
    );

    const triggerIdx = prompt.indexOf(PROMPT_SECTIONS.TRIGGERING_EVENT);
    const timelineIdx = prompt.indexOf(PROMPT_SECTIONS.TIMELINE);
    const clustersIdx = prompt.indexOf(PROMPT_SECTIONS.CLUSTERS);
    const gapsIdx = prompt.indexOf(PROMPT_SECTIONS.GAPS);

    expect(timelineIdx).toBeGreaterThan(0);
    expect(clustersIdx).toBeGreaterThan(timelineIdx);
    expect(gapsIdx).toBeGreaterThan(clustersIdx);
    expect(triggerIdx).toBeGreaterThan(gapsIdx);
  });
});
