import { describe, it, expect } from "vitest";
import {
  filterRecipientsBySpecialty,
  type CandidateRecipient,
} from "../workers/specialty-filter.js";

/**
 * Regression tests for HIPAA § 164.502(b) (minimum-necessary) fix on
 * clinical-flag notification dispatch. See issue #293.
 */

const onco: CandidateRecipient = {
  id: "user-onco",
  specialty: "Hematology/Oncology",
  role: "physician",
};

const cards: CandidateRecipient = {
  id: "user-cards",
  specialty: "Cardiology",
  role: "physician",
};

const neuro: CandidateRecipient = {
  id: "user-neuro",
  specialty: "Neurology",
  role: "physician",
};

const infDis: CandidateRecipient = {
  id: "user-infdis",
  specialty: "Infectious Disease",
  role: "physician",
};

const admin: CandidateRecipient = {
  id: "user-admin",
  specialty: null,
  role: "admin",
};

const nurseNoSpecialty: CandidateRecipient = {
  id: "user-nurse",
  specialty: null,
  role: "nurse",
};

describe("filterRecipientsBySpecialty", () => {
  it("returns only providers whose specialty matches notify_specialties (regression: issue #293)", () => {
    const result = filterRecipientsBySpecialty(
      [onco, cards, neuro],
      ["oncology"],
    );
    expect(result).toEqual(["user-onco"]);
    expect(result).not.toContain("user-cards");
    expect(result).not.toContain("user-neuro");
  });

  it("matches composite specialty strings like 'Hematology/Oncology' against either token", () => {
    const hemeOnly = filterRecipientsBySpecialty([onco], ["hematology"]);
    expect(hemeOnly).toEqual(["user-onco"]);

    const oncoOnly = filterRecipientsBySpecialty([onco], ["oncology"]);
    expect(oncoOnly).toEqual(["user-onco"]);
  });

  it("matches specialty tags with underscores against space-separated specialty labels", () => {
    // Rule lexicon uses snake_case; user specialty uses spaces.
    const result = filterRecipientsBySpecialty(
      [infDis, cards],
      ["infectious_disease"],
    );
    expect(result).toEqual(["user-infdis"]);
  });

  it("comparison is case-insensitive in both directions", () => {
    const result = filterRecipientsBySpecialty(
      [{ id: "u1", specialty: "CARDIOLOGY", role: "physician" }],
      ["cardiology"],
    );
    expect(result).toEqual(["u1"]);
  });

  it("always includes admin users regardless of specialty targeting", () => {
    const result = filterRecipientsBySpecialty(
      [cards, admin],
      ["oncology"],
    );
    expect(result).toContain("user-admin");
    expect(result).not.toContain("user-cards");
  });

  it("falls back to every candidate when notify_specialties is empty", () => {
    const result = filterRecipientsBySpecialty(
      [onco, cards, neuro, nurseNoSpecialty],
      [],
    );
    expect(result.sort()).toEqual(
      ["user-cards", "user-neuro", "user-nurse", "user-onco"].sort(),
    );
  });

  it("falls back to every candidate when notify_specialties is null", () => {
    const result = filterRecipientsBySpecialty(
      [onco, cards],
      null,
    );
    expect(result.sort()).toEqual(["user-cards", "user-onco"].sort());
  });

  it("does NOT silently fall back to the full care team when a specialty-scoped flag has no matches (PHI over-disclosure bug)", () => {
    // This is the regression: previously, when the DB filter returned 0
    // rows the worker would dispatch to every care-team provider, leaking
    // Oncology PHI to unrelated specialists.
    const result = filterRecipientsBySpecialty(
      [cards, neuro],
      ["oncology"],
    );
    expect(result).toEqual([]);
  });

  it("returns only admins when a specialty-scoped flag has no provider matches", () => {
    const result = filterRecipientsBySpecialty(
      [cards, neuro, admin],
      ["oncology"],
    );
    expect(result).toEqual(["user-admin"]);
  });

  it("excludes users with a null specialty from specialty-scoped flags", () => {
    const result = filterRecipientsBySpecialty(
      [onco, nurseNoSpecialty],
      ["oncology"],
    );
    expect(result).toEqual(["user-onco"]);
    expect(result).not.toContain("user-nurse");
  });

  it("honours multiple specialties in notify_specialties (OR semantics)", () => {
    const result = filterRecipientsBySpecialty(
      [onco, cards, neuro],
      ["neurology", "hematology"],
    );
    expect(result.sort()).toEqual(["user-neuro", "user-onco"].sort());
  });
});
