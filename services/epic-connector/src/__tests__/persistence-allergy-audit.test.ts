/**
 * Pre-update field snapshot in the allergy dedup-merge audit (#1203).
 *
 * `findAllergyByFingerprint` keys on (patient_id, rxnorm_code | snomed_code)
 * with no temporal dimension — a re-evaluated allergy (same SNOMED/RxNorm,
 * updated severity/reaction) merges silently. #1200's source_system guard
 * prevents Epic from overwriting CareBridge-originated rows, but when the
 * matched row IS Epic-sourced the merge proceeds and the clinician-edited
 * prior values are lost without provenance.
 *
 * #1203 (this file) pins the pre-update snapshot: the `epic_sync_dedup_match`
 * audit row's payload now carries
 *   { overwritten_fields: { severity: priorValue, reaction: priorValue, ... } }
 * for every field whose value actually changed on the UPDATE. No-op merges
 * write no `overwritten_fields` key — the audit weight is only earned when
 * a clinically meaningful field flipped.
 *
 * The set of fields captured matches what `persistAllergy`'s UPDATE writes
 * (allergen, severity, reaction). Widening the UPDATE in a follow-up
 * automatically widens the snapshot via the same shared computation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";
import type { FhirResource } from "../fhir-types.js";

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  patients: {
    id: "id",
    mrn_hmac: "mrn_hmac",
    patient_id: "patient_id",
  },
  medications: {
    id: "id",
    patient_id: "patient_id",
    rxnorm_code: "rxnorm_code",
    started_at: "started_at",
  },
  vitals: {
    id: "id",
    patient_id: "patient_id",
    loinc_code: "loinc_code",
    recorded_at: "recorded_at",
  },
  labPanels: {},
  labResults: {},
  diagnoses: {
    id: "id",
    patient_id: "patient_id",
    icd10_code: "icd10_code",
    snomed_code: "snomed_code",
    onset_date: "onset_date",
  },
  allergies: {
    id: "id",
    patient_id: "patient_id",
    rxnorm_code: "rxnorm_code",
    snomed_code: "snomed_code",
  },
  encounters: {
    id: "id",
    patient_id: "patient_id",
    start_time: "start_time",
    encounter_type: "encounter_type",
  },
  fhirResources: {
    id: "id",
    resource_type: "resource_type",
    resource_id: "resource_id",
    internal_record_id: "internal_record_id",
  },
  auditLog: {},
  hmacForIndex: (value: string) => `hmac:${value}`,
}));

const { persistAllergy } = await import("../sync/persistence.js");

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
});

function findAuditInsert(
  action: string,
): Record<string, unknown> | undefined {
  const hit = db.insert.calls.find((c) => {
    const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
    return v?.action === action;
  });
  return hit?.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
}

/**
 * Build a FHIR AllergyIntolerance resource with caller-controlled
 * severity + reaction so we can drive the merge with explicit "new"
 * values. SNOMED 373270004 = Penicillin (same fingerprint as the
 * existing #1191/#1200 allergy tests).
 */
function buildInboundAllergy(opts: {
  severity?: "mild" | "moderate" | "severe";
  reactionText?: string;
  verificationStatus?: "unconfirmed" | "confirmed" | "refuted";
}): FhirResource {
  const reaction: Record<string, unknown> = {};
  if (opts.reactionText) reaction.description = opts.reactionText;
  if (opts.severity) reaction.severity = opts.severity;
  const hasReaction = Object.keys(reaction).length > 0;
  const resource: FhirResource = {
    resourceType: "AllergyIntolerance",
    id: "epic-aller-1",
    patient: { reference: "Patient/p-1" },
    code: {
      text: "Penicillin",
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "373270004",
          display: "Penicillin",
        },
      ],
    },
    clinicalStatus: {
      coding: [
        {
          system:
            "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
          code: "active",
        },
      ],
    },
    ...(hasReaction ? { reaction: [reaction] } : {}),
  };
  if (opts.verificationStatus) {
    (resource as Record<string, unknown>).verificationStatus = {
      coding: [
        {
          system:
            "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
          code: opts.verificationStatus,
        },
      ],
    };
  }
  return resource;
}

describe("persistAllergy — dedup-merge audit snapshots prior values (#1203)", () => {
  it("severity flip (severe → moderate) captures prior severity in overwritten_fields", async () => {
    const existingInternalId = "internal-aller-cs1";
    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        allergen: "Penicillin",
        severity: "severe",
        reaction: "anaphylaxis",
        verification_status: "unconfirmed",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert(); // mapping upsert
    db.willInsert(); // audit_log

    const resource = buildInboundAllergy({
      severity: "moderate",
      reactionText: "anaphylaxis", // unchanged
    });

    const result = await persistAllergy(resource, PATIENT_ID);
    expect(result.internalId).toBe(existingInternalId);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();

    const audit = findAuditInsert("epic_sync_dedup_match");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.overwritten_fields).toEqual({ severity: "severe" });
    // Existing payload contract from #1191 still holds.
    expect(details.epic_fhir_id).toBe("epic-aller-1");
    expect(details.reason).toBe("fingerprint_match");
    expect(details.fingerprint?.snomed_code).toBe("373270004");
  });

  it("all merge fields differ → all prior values captured", async () => {
    const existingInternalId = "internal-aller-cs2";
    db.willSelect([]);
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        allergen: "Penicillin G",
        severity: "severe",
        reaction: "anaphylaxis",
        verification_status: "unconfirmed",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    // Inbound: severity=moderate, reaction=rash, allergen normalised to
    // 'Penicillin' (different from existing 'Penicillin G').
    const resource = buildInboundAllergy({
      severity: "moderate",
      reactionText: "rash",
    });

    const result = await persistAllergy(resource, PATIENT_ID);
    expect(result.conflict).toBeUndefined();

    const audit = findAuditInsert("epic_sync_dedup_match");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.overwritten_fields).toEqual({
      allergen: "Penicillin G",
      severity: "severe",
      reaction: "anaphylaxis",
    });
  });

  it("no-op merge (identical inbound values) → no overwritten_fields key", async () => {
    const existingInternalId = "internal-aller-cs3";
    db.willSelect([]);
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        allergen: "Penicillin",
        severity: "moderate",
        reaction: "rash",
        verification_status: "unconfirmed",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const resource = buildInboundAllergy({
      severity: "moderate",
      reactionText: "rash",
    });

    const result = await persistAllergy(resource, PATIENT_ID);
    expect(result.conflict).toBeUndefined();

    const audit = findAuditInsert("epic_sync_dedup_match");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details).not.toHaveProperty("overwritten_fields");
  });

  it("partial overwrite — only severity changes → only severity captured", async () => {
    const existingInternalId = "internal-aller-cs4";
    db.willSelect([]);
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        allergen: "Penicillin",
        severity: "severe",
        reaction: "rash",
        verification_status: "unconfirmed",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const resource = buildInboundAllergy({
      severity: "moderate",
      reactionText: "rash", // unchanged
    });

    const result = await persistAllergy(resource, PATIENT_ID);
    expect(result.conflict).toBeUndefined();

    const audit = findAuditInsert("epic_sync_dedup_match");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.overwritten_fields).toEqual({ severity: "severe" });
  });

  it("acceptance criterion — severity flip with verification flip both captured (#1220)", async () => {
    // Mirrors the issue body: penicillin in 2020 (severity=moderate,
    // verification_status=unconfirmed) → re-evaluated 2024 (severity=severe,
    // verification_status=confirmed). Post-#1220 the UPDATE now writes
    // verification_status alongside allergen/severity/reaction, so the
    // diff helper captures both flips.
    const existingInternalId = "internal-aller-issue";
    db.willSelect([]);
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        allergen: "Penicillin",
        severity: "moderate",
        reaction: "anaphylaxis",
        verification_status: "unconfirmed",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const resource = buildInboundAllergy({
      severity: "severe",
      reactionText: "anaphylaxis",
      verificationStatus: "confirmed",
    });

    await persistAllergy(resource, PATIENT_ID);
    const audit = findAuditInsert("epic_sync_dedup_match");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.overwritten_fields).toEqual({
      severity: "moderate",
      verification_status: "unconfirmed",
    });
  });

  it("verification_status flip only (unconfirmed → confirmed) captured in overwritten_fields (#1220)", async () => {
    // Pure verification_status flip: every other clinically meaningful
    // column on the merge surface matches the inbound row. The diff
    // helper still records the verification flip — re-evaluation of an
    // unconfirmed allergy to confirmed is clinically meaningful even
    // when allergen/severity/reaction are unchanged.
    const existingInternalId = "internal-aller-vs1";
    db.willSelect([]);
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        allergen: "Penicillin",
        severity: "moderate",
        reaction: "rash",
        verification_status: "unconfirmed",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const resource = buildInboundAllergy({
      severity: "moderate",
      reactionText: "rash",
      verificationStatus: "confirmed",
    });

    await persistAllergy(resource, PATIENT_ID);
    const audit = findAuditInsert("epic_sync_dedup_match");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.overwritten_fields).toEqual({
      verification_status: "unconfirmed",
    });
  });
});
