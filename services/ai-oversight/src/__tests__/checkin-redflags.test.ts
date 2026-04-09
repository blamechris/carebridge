/**
 * Phase B4 — checkin-redflags rule family tests.
 *
 * Pure function tests. Each rule gets (a) a positive case that fires,
 * (b) a negative case that doesn't, and (c) targeted checks on the
 * summary / category / severity so regressions in flag metadata are
 * caught.
 */
import { describe, it, expect } from "vitest";
import {
  checkCheckInRedFlags,
  type CheckInRuleContext,
  type PriorCheckInSummary,
} from "../rules/checkin-redflags.js";

const NOW = new Date("2026-04-09T12:00:00.000Z");

function baseContext(
  overrides: Partial<CheckInRuleContext> = {},
): CheckInRuleContext {
  return {
    current: {
      id: "ci-current",
      template_slug: "oncology-weekly",
      template_version: 1,
      target_condition: "oncology",
      red_flag_hits: [],
      submitted_at: "2026-04-09T11:30:00.000Z",
      submitted_by_relationship: "self",
    },
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: [],
    prior_checkins: [],
    now: NOW,
    ...overrides,
  };
}

// ─── CHECKIN-NEURO-ONCO-VTE-001 ──────────────────────────────────

describe("CHECKIN-NEURO-ONCO-VTE-001", () => {
  it("fires for an oncology-weekly neuro hit in a cancer + VTE patient", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["new_neuro_symptoms"],
      },
      active_diagnoses: [
        "Adenocarcinoma of the pancreas",
        "Deep vein thrombosis, left lower extremity",
      ],
    });
    const flags = checkCheckInRedFlags(ctx);
    const flag = flags.find(
      (f) => f.rule_id === "CHECKIN-NEURO-ONCO-VTE-001",
    );
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("critical");
    expect(flag?.category).toBe("cross-specialty");
    expect(flag?.summary.toLowerCase()).toContain("neurological");
  });

  it("does not fire without VTE", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["new_neuro_symptoms"],
      },
      active_diagnoses: ["Adenocarcinoma of the pancreas"],
    });
    const flags = checkCheckInRedFlags(ctx);
    expect(
      flags.find((f) => f.rule_id === "CHECKIN-NEURO-ONCO-VTE-001"),
    ).toBeUndefined();
  });

  it("does not fire without the oncology-weekly slug", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        template_slug: "daily-symptom-diary",
        target_condition: "general",
        red_flag_hits: ["new_neuro_symptoms"],
      },
      active_diagnoses: ["Cancer", "DVT"],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-NEURO-ONCO-VTE-001",
      ),
    ).toBeUndefined();
  });
});

// ─── CHECKIN-CHEMO-FEVER-001 ─────────────────────────────────────

describe("CHECKIN-CHEMO-FEVER-001", () => {
  it("fires when an oncology patient on chemotherapy reports fever", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["fever"],
      },
      active_medications: ["Cisplatin", "Pembrolizumab"],
    });
    const flag = checkCheckInRedFlags(ctx).find(
      (f) => f.rule_id === "CHECKIN-CHEMO-FEVER-001",
    );
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("critical");
    expect(flag?.notify_specialties).toContain("Oncology");
  });

  it("fires on chills_or_rigors even without a literal fever hit", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["chills_or_rigors"],
      },
      active_medications: ["Carboplatin"],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-CHEMO-FEVER-001",
      ),
    ).toBeDefined();
  });

  it("does not fire when the patient is not on chemotherapy", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["fever"],
      },
      active_medications: ["Acetaminophen"],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-CHEMO-FEVER-001",
      ),
    ).toBeUndefined();
  });
});

// ─── CHECKIN-CHF-DECOMP-001 ──────────────────────────────────────

describe("CHECKIN-CHF-DECOMP-001", () => {
  const cardiacCurrent: CheckInRuleContext["current"] = {
    id: "ci-current",
    template_slug: "cardiac-weekly",
    template_version: 1,
    target_condition: "cardiac",
    red_flag_hits: ["weight_gain_lbs", "dyspnea_at_rest"],
    submitted_at: "2026-04-09T11:30:00.000Z",
    submitted_by_relationship: "self",
  };

  it("fires for heart-failure patient with weight gain + dyspnea", () => {
    const ctx = baseContext({
      current: cardiacCurrent,
      active_diagnoses: ["Congestive heart failure, unspecified"],
    });
    const flag = checkCheckInRedFlags(ctx).find(
      (f) => f.rule_id === "CHECKIN-CHF-DECOMP-001",
    );
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("warning");
    expect(flag?.category).toBe("trend-concern");
  });

  it("does not fire without heart-failure diagnosis", () => {
    const ctx = baseContext({
      current: cardiacCurrent,
      active_diagnoses: ["Hypertension"],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-CHF-DECOMP-001",
      ),
    ).toBeUndefined();
  });

  it("does not fire with weight gain but no dyspnea hit", () => {
    const ctx = baseContext({
      current: {
        ...cardiacCurrent,
        red_flag_hits: ["weight_gain_lbs"],
      },
      active_diagnoses: ["Heart failure"],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-CHF-DECOMP-001",
      ),
    ).toBeUndefined();
  });
});

// ─── CHECKIN-POSTOP-INFECTION-001 ────────────────────────────────

describe("CHECKIN-POSTOP-INFECTION-001", () => {
  const postopCurrent: CheckInRuleContext["current"] = {
    id: "ci-current",
    template_slug: "post-discharge-red-flags",
    template_version: 1,
    target_condition: "post_discharge",
    red_flag_hits: ["wound_problem", "fever"],
    submitted_at: "2026-04-09T11:30:00.000Z",
    submitted_by_relationship: "self",
  };

  it("fires when both wound_problem and fever are red flags", () => {
    const flags = checkCheckInRedFlags(
      baseContext({ current: postopCurrent }),
    );
    const flag = flags.find((f) => f.rule_id === "CHECKIN-POSTOP-INFECTION-001");
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("warning");
    expect(flag?.category).toBe("care-gap");
  });

  it("does not fire when only the wound question hit", () => {
    const flags = checkCheckInRedFlags(
      baseContext({
        current: { ...postopCurrent, red_flag_hits: ["wound_problem"] },
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "CHECKIN-POSTOP-INFECTION-001"),
    ).toBeUndefined();
  });
});

// ─── CHECKIN-SEVERE-SYMPTOM-001 ──────────────────────────────────

describe("CHECKIN-SEVERE-SYMPTOM-001", () => {
  const prior = (
    hoursAgo: number,
    hits: string[],
  ): PriorCheckInSummary => ({
    id: `ci-prior-${hoursAgo}`,
    template_slug: "daily-symptom-diary",
    template_version: 1,
    target_condition: "general",
    red_flag_hits: hits,
    submitted_at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
  });

  it("fires when the current submission has red flags AND a prior red-flag submission exists within 48h", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["pain"],
        submitted_at: NOW.toISOString(),
      },
      prior_checkins: [prior(24, ["pain"])],
    });
    const flag = checkCheckInRedFlags(ctx).find(
      (f) => f.rule_id === "CHECKIN-SEVERE-SYMPTOM-001",
    );
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("info");
    expect(flag?.category).toBe("care-gap");
  });

  it("does not fire when the current submission has no red-flag hits", () => {
    const ctx = baseContext({
      prior_checkins: [prior(12, ["pain"])],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-SEVERE-SYMPTOM-001",
      ),
    ).toBeUndefined();
  });

  it("does not fire when the prior submission is outside the 48h window", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["pain"],
        submitted_at: NOW.toISOString(),
      },
      prior_checkins: [prior(72, ["pain"])],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-SEVERE-SYMPTOM-001",
      ),
    ).toBeUndefined();
  });

  it("does not fire when the prior submission had no red-flag hits", () => {
    const ctx = baseContext({
      current: {
        ...baseContext().current,
        red_flag_hits: ["pain"],
        submitted_at: NOW.toISOString(),
      },
      prior_checkins: [prior(12, [])],
    });
    expect(
      checkCheckInRedFlags(ctx).find(
        (f) => f.rule_id === "CHECKIN-SEVERE-SYMPTOM-001",
      ),
    ).toBeUndefined();
  });
});
