/**
 * RBAC-enforced patient-records router.
 *
 * Patient-scoped read/write procedures call enforcePatientAccess() before
 * querying the database.
 *
 * Administrative procedures (create, list) are restricted to non-patient roles.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import {
  getDb,
  hmacForIndex,
  patients,
  diagnoses,
  allergies,
  allergyOverrides,
  auditLog,
  careTeamMembers,
  careTeamAssignments,
  clinicalFlags,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
import { createPatientSchema, updatePatientSchema } from "@carebridge/validators";
import {
  listObservationsByPatient,
  createObservation,
  createDiagnosis,
  updateDiagnosis,
  createAllergy,
  updateAllergy,
} from "@carebridge/patient-records";
import {
  createDiagnosisSchema,
  updateDiagnosisSchema,
  createAllergySchema,
  updateAllergySchema,
  overrideAllergyFlagSchema,
} from "@carebridge/validators";
import {
  hasScope,
  normaliseScopes,
  type ScopeToken,
} from "@carebridge/shared-types";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import type { Context } from "../context.js";
import { assertCareTeamAccess } from "../middleware/rbac.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

/**
 * Enforce HIPAA minimum-necessary access for a given user / patientId pair.
 * Throws TRPCError(FORBIDDEN) on denial.
 *
 * Role semantics:
 *  - admin: unrestricted, scope-bypass
 *  - patient: own record only (user.patient_id === patientId; user.id fallback
 *    preserved for test fixtures that do not set patient_id). Scope-bypass —
 *    patients viewing their own record are not subject to caregiver scopes.
 *  - family_caregiver: must have an active family_relationships row linking
 *    the caller's user.id to a user whose users.patient_id matches the
 *    requested patient record id. Caregivers never satisfy the clinician
 *    care-team check, so they must be resolved via this path. When
 *    `requiredScope` is provided, the relationship's `access_scopes` array
 *    is checked via `hasScope` — see @carebridge/shared-types#auth for the
 *    superset rules. `null` / empty scope arrays fall back to
 *    `DEFAULT_CAREGIVER_SCOPES` (`["read_only"]`) for backward compat with
 *    rows that predate the column.
 *  - clinicians (physician, specialist, nurse): active care-team assignment.
 *    Scope-bypass — care-team membership is the clinical-minimum-necessary
 *    gate; scopes are caregiver-only.
 *
 * The `requiredScope` parameter is optional — callers that do not pass it
 * get the legacy role-check behaviour. This lets mixed call sites (e.g. a
 * clinician-only mutation that blocks caregiver roles before the access
 * check) skip the scope path without changing existing semantics.
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
  requiredScope?: ScopeToken,
  clientIp?: string | null,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    const ownRecord = user.patient_id ?? user.id;
    if (ownRecord !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only access their own records",
      });
    }
    return;
  }

  if (user.role === "family_caregiver") {
    const relationship = await findActiveFamilyRelationship(user.id, patientId);
    if (!relationship) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Access denied: no active family relationship grants access to this patient",
      });
    }
    if (requiredScope !== undefined) {
      // normaliseScopes is safety-critical: an existing row with a null /
      // empty access_scopes column must NOT be treated as "all scopes" —
      // treat it as the minimum safe default and deny anything above
      // view_summary. See DEFAULT_CAREGIVER_SCOPES.
      if (!hasScope(normaliseScopes(relationship.access_scopes), requiredScope)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Access denied: caregiver lacks ${requiredScope} scope`,
        });
      }
    }
    return;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
  // clientIp is forwarded so the emergency_access_used audit row written
  // inside assertCareTeamAccess captures the originating IP (HIPAA § 164.312(b)).
  const hasAccess = await assertCareTeamAccess(user.id, patientId, clientIp);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: no active care-team assignment for this patient",
    });
  }
}

/**
 * Resolve the active family_relationships row linking the caregiver to the
 * given patient record, including its `access_scopes` array. Returns null
 * when no active relationship exists.
 *
 * family_relationships.patient_id references users.id (the patient's user
 * account), but requests identify the subject by patients.id, so the query
 * joins through users to close the mapping.
 */
async function findActiveFamilyRelationship(
  caregiverUserId: string,
  patientRecordId: string,
): Promise<{ id: string; access_scopes: ScopeToken[] | null } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: familyRelationships.id,
      access_scopes: familyRelationships.access_scopes,
    })
    .from(familyRelationships)
    .innerJoin(users, eq(users.id, familyRelationships.patient_id))
    .where(
      and(
        eq(familyRelationships.caregiver_id, caregiverUserId),
        eq(users.patient_id, patientRecordId),
        eq(familyRelationships.status, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    access_scopes: (row.access_scopes ?? null) as ScopeToken[] | null,
  };
}

/**
 * HIPAA §164.502(b) minimum-necessary column set for patient list endpoints.
 *
 * Excludes insurance_id, emergency_contact_*, and free-text notes — callers
 * that need those fields must use a dedicated endpoint scoped to the use case.
 */
const patientListColumns = {
  id: patients.id,
  name: patients.name,
  name_hmac: patients.name_hmac,
  date_of_birth: patients.date_of_birth,
  biological_sex: patients.biological_sex,
  diagnosis: patients.diagnosis,
  primary_provider_id: patients.primary_provider_id,
  allergy_status: patients.allergy_status,
  weight_kg: patients.weight_kg,
  mrn: patients.mrn,
  mrn_hmac: patients.mrn_hmac,
  created_at: patients.created_at,
  updated_at: patients.updated_at,
} as const;

export const patientRecordsRbacRouter = t.router({
  // Administrative: creating a patient record is restricted to non-patient roles.
  create: protectedProcedure
    .input(createPatientSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "patient") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Patients cannot create patient records",
        });
      }
      const db = getDb();
      const now = new Date().toISOString();
      const mrn_hmac = input.mrn ? hmacForIndex(input.mrn) : undefined;
      const patient = {
        id: crypto.randomUUID(),
        ...input,
        mrn_hmac,
        created_at: now,
        updated_at: now,
      };
      await db.insert(patients).values(patient);
      return patient;
    }),

  // Updating a patient record is patient-scoped: input.id is the patientId.
  update: protectedProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updatePatientSchema))
    .mutation(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.id, undefined, ctx.clientIp);
      const { id, ...data } = input;
      const db = getDb();
      const mrn_hmac =
        data.mrn !== undefined ? (data.mrn ? hmacForIndex(data.mrn) : null) : undefined;
      const updates = {
        ...data,
        ...(mrn_hmac !== undefined ? { mrn_hmac } : {}),
        updated_at: new Date().toISOString(),
      };
      await db.update(patients).set(updates).where(eq(patients.id, id));
      return { id, ...data };
    }),

  // Reading a specific patient record is patient-scoped: input.id is the patientId.
  //
  // Explicit field selection (HIPAA §164.502(b) minimum necessary): insurance_id,
  // emergency_contact_*, and patient-level free-text notes are intentionally
  // NOT returned here. Callers that need them must use a dedicated endpoint —
  // that scopes the PHI exposure to the use case rather than every getById
  // implicitly leaking billing and contact data to every consumer.
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      // view_summary: patient record projection falls under the blanket
      // "summary" permit — see resource→scope mapping in #896.
      await enforcePatientAccess(ctx.user, input.id, "view_summary", ctx.clientIp);
      const db = getDb();
      const [patient] = await db
        .select({
          id: patients.id,
          name: patients.name,
          name_hmac: patients.name_hmac,
          date_of_birth: patients.date_of_birth,
          biological_sex: patients.biological_sex,
          diagnosis: patients.diagnosis,
          mrn: patients.mrn,
          mrn_hmac: patients.mrn_hmac,
          primary_provider_id: patients.primary_provider_id,
          allergy_status: patients.allergy_status,
          weight_kg: patients.weight_kg,
          created_at: patients.created_at,
          updated_at: patients.updated_at,
        })
        .from(patients)
        .where(eq(patients.id, input.id));
      return patient ?? null;
    }),

  // Minimum-necessary summary for banner / lookup use cases.
  //
  // Returns only the fields needed to identify a patient — no date-of-birth,
  // no diagnosis, no weight, no billing data. Callers that need richer data
  // should prefer `getById`; callers that only need a name/MRN tile should
  // use this endpoint to avoid incidentally fetching PHI.
  getSummary: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.id, "view_summary", ctx.clientIp);
      const db = getDb();
      const [patient] = await db
        .select({
          id: patients.id,
          name: patients.name,
          mrn: patients.mrn,
        })
        .from(patients)
        .where(eq(patients.id, input.id));
      return patient ?? null;
    }),

  /**
   * Patients the current user is authorised to view in the patient portal.
   *
   * Returns a minimum-necessary summary (id, name, mrn, relationship) used
   * to power the "which patient am I viewing" UI. Client-side code persists
   * a selection in localStorage, but every downstream read still runs through
   * enforcePatientAccess, so this endpoint is a UX helper — not the
   * authorisation boundary.
   *
   * Role semantics:
   *  - patient: returns exactly one entry (themselves), relationship "self".
   *  - family_caregiver: returns every patient linked via an active
   *    family_relationships row, keyed by patients.id. The relationship_type
   *    (spouse/parent/child/sibling/...) is included so the UI can render
   *    "Viewing as spouse for Jane Doe".
   *  - clinicians (physician, specialist, nurse) and admins: returns an
   *    empty list. The patient portal is not a clinician surface — these
   *    roles use the clinician portal's dedicated patient selector.
   */
  getMyPatients: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();

    if (ctx.user.role === "patient") {
      if (!ctx.user.patient_id) return [];
      const [row] = await db
        .select({ id: patients.id, name: patients.name, mrn: patients.mrn })
        .from(patients)
        .where(eq(patients.id, ctx.user.patient_id));
      if (!row) return [];
      // Patients viewing their own record implicitly hold every scope —
      // the scope system exists to gate DELEGATED caregiver access, not
      // first-person access. Returning the full token set here keeps the
      // UI uniform (it can read `scopes` regardless of role).
      return [
        {
          ...row,
          relationship: "self" as const,
          scopes: ["view_and_message"] as ScopeToken[],
        },
      ];
    }

    if (ctx.user.role === "family_caregiver") {
      // Select the scope set along with the relationship_type so the UI can
      // grey out sections the caregiver lacks access to (see #896).
      const rels = await db
        .select({
          patient_user_id: familyRelationships.patient_id,
          relationship_type: familyRelationships.relationship_type,
          access_scopes: familyRelationships.access_scopes,
        })
        .from(familyRelationships)
        .where(
          and(
            eq(familyRelationships.caregiver_id, ctx.user.id),
            eq(familyRelationships.status, "active"),
          ),
        );
      if (rels.length === 0) return [];

      const userRows = await db
        .select({ id: users.id, patient_id: users.patient_id })
        .from(users)
        .where(
          and(
            inArray(
              users.id,
              rels.map((r) => r.patient_user_id),
            ),
            isNotNull(users.patient_id),
          ),
        );
      const patientIds = userRows
        .map((u) => u.patient_id)
        .filter((id): id is string => Boolean(id));
      if (patientIds.length === 0) return [];

      const patientRows = await db
        .select({ id: patients.id, name: patients.name, mrn: patients.mrn })
        .from(patients)
        .where(inArray(patients.id, patientIds));

      // Re-join in memory so the relationship_type and scopes travel with
      // each row.
      const patientIdByUserId = new Map<string, string>();
      for (const u of userRows) {
        if (u.patient_id) patientIdByUserId.set(u.id, u.patient_id);
      }
      const relationshipByPatientId = new Map<string, string>();
      const scopesByPatientId = new Map<string, ScopeToken[]>();
      for (const r of rels) {
        const pid = patientIdByUserId.get(r.patient_user_id);
        if (pid) {
          relationshipByPatientId.set(pid, r.relationship_type);
          // Apply the same empty-column fallback the access check uses so
          // the UI sees exactly the scopes the server will enforce.
          scopesByPatientId.set(
            pid,
            [...normaliseScopes((r.access_scopes ?? null) as ScopeToken[] | null)] as ScopeToken[],
          );
        }
      }
      return patientRows.map((p) => ({
        id: p.id,
        name: p.name,
        mrn: p.mrn,
        relationship: relationshipByPatientId.get(p.id) ?? "caregiver",
        scopes: scopesByPatientId.get(p.id) ?? [],
      }));
    }

    // Clinicians and admins use the clinician portal.
    return [];
  }),

  // HIPAA minimum-necessary: filter patient list by role.
  //   - patient: only their own record
  //   - admin: full list
  //   - family_caregiver: only patients linked via an active family_relationships row
  //   - clinician (nurse/physician/specialist): only patients with an active care-team assignment
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();

    // Patients see only their own record.
    if (ctx.user.role === "patient") {
      if (!ctx.user.patient_id) {
        return [];
      }
      return db
        .select(patientListColumns)
        .from(patients)
        .where(eq(patients.id, ctx.user.patient_id));
    }

    // Admins see all patients.
    if (ctx.user.role === "admin") {
      return db.select(patientListColumns).from(patients);
    }

    // Family caregivers: only patients linked via an active family_relationships row.
    if (ctx.user.role === "family_caregiver") {
      const activeRelationships = await db
        .select({ patient_user_id: familyRelationships.patient_id })
        .from(familyRelationships)
        .where(
          and(
            eq(familyRelationships.caregiver_id, ctx.user.id),
            eq(familyRelationships.status, "active"),
          ),
        );
      if (activeRelationships.length === 0) {
        return [];
      }
      const patientUserIds = activeRelationships.map((r) => r.patient_user_id);
      const linkedUsers = await db
        .select({ patient_id: users.patient_id })
        .from(users)
        .where(
          and(
            inArray(users.id, patientUserIds),
            isNotNull(users.patient_id),
          ),
        );
      const patientRecordIds = linkedUsers
        .map((u) => u.patient_id)
        .filter((id): id is string => Boolean(id));
      if (patientRecordIds.length === 0) {
        return [];
      }
      return db.select(patientListColumns).from(patients).where(inArray(patients.id, patientRecordIds));
    }

    // Clinicians (physician, specialist, nurse): only patients with an
    // active care_team_assignments entry for this user.
    return db
      .select(patientListColumns)
      .from(patients)
      .innerJoin(
        careTeamAssignments,
        eq(patients.id, careTeamAssignments.patient_id),
      )
      .where(
        and(
          eq(careTeamAssignments.user_id, ctx.user.id),
          isNull(careTeamAssignments.removed_at),
        ),
      );
  }),

  // Return the most recent patients (admin-only dashboard widget).
  // Uses patientListColumns projection + .limit() without .where() for the
  // admin path — keeps HIPAA minimum-necessary while giving a quick overview.
  listRecent: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional().default(10) }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can list recent patients",
        });
      }
      const db = getDb();
      return db.select(patientListColumns).from(patients).orderBy(desc(patients.created_at)).limit(input.limit);
    }),

  diagnoses: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        // view_summary gates the summary-tier read (diagnoses/allergies/obs).
        await enforcePatientAccess(ctx.user, input.patientId, "view_summary", ctx.clientIp);
        const db = getDb();
        return db
          .select()
          .from(diagnoses)
          .where(eq(diagnoses.patient_id, input.patientId));
      }),

    create: protectedProcedure
      .input(createDiagnosisSchema)
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || ctx.user.role === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot create clinical diagnoses",
          });
        }
        await enforcePatientAccess(ctx.user, input.patient_id, undefined, ctx.clientIp);
        return createDiagnosis(input);
      }),

    update: protectedProcedure
      .input(z.object({ id: z.string().uuid() }).merge(updateDiagnosisSchema))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || ctx.user.role === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot update clinical diagnoses",
          });
        }
        const { id, ...data } = input;
        // Look up the diagnosis to get the patient_id for access check
        const db = getDb();
        const [existing] = await db
          .select()
          .from(diagnoses)
          .where(eq(diagnoses.id, id))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Diagnosis ${id} not found` });
        }
        await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);
        return updateDiagnosis(id, data);
      }),
  }),

  allergies: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId, "view_summary", ctx.clientIp);
        const db = getDb();
        return db
          .select()
          .from(allergies)
          .where(eq(allergies.patient_id, input.patientId));
      }),

    create: protectedProcedure
      .input(createAllergySchema)
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || ctx.user.role === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot create clinical allergies",
          });
        }
        await enforcePatientAccess(ctx.user, input.patient_id, undefined, ctx.clientIp);
        return createAllergy(input);
      }),

    update: protectedProcedure
      .input(z.object({ id: z.string().uuid() }).merge(updateAllergySchema))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || ctx.user.role === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot update clinical allergies",
          });
        }
        const { id, ...data } = input;
        const db = getDb();
        const [existing] = await db
          .select()
          .from(allergies)
          .where(eq(allergies.id, id))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Allergy ${id} not found` });
        }
        await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);
        return updateAllergy(id, data);
      }),

    /**
     * Formally override an allergy / contraindication warning (issue #233).
     *
     * Unlike the generic `aiOversight.flags.dismiss` (which takes optional
     * free-text `dismiss_reason`), this procedure REQUIRES a structured
     * `override_reason` enum value plus a substantive
     * `clinical_justification`. The pairing gives HIPAA quality reviewers
     * a stable aggregation key *and* a human-readable narrative.
     *
     * Three rows are written in a single transaction:
     *   1. `allergy_overrides` — the permanent, structured record.
     *   2. `clinical_flags` — the triggering flag transitions to `dismissed`
     *      with a summarised `dismiss_reason` for backwards compatibility
     *      with existing flag-dismissal UIs.
     *   3. `audit_log` — an explicit row capturing actor, flag_id, reason,
     *      and justification. The onResponse audit middleware also writes
     *      a generic procedure-level row, but this explicit entry is what
     *      reviewers will query when auditing override patterns.
     *
     * Role gate: nurses, patients, and family_caregivers cannot override —
     * only physicians, specialists, and admins. Care-team access is
     * enforced via enforcePatientAccess (admin bypass preserved).
     */
    override: protectedProcedure
      .input(overrideAllergyFlagSchema)
      .mutation(async ({ ctx, input }) => {
        if (
          ctx.user.role !== "physician" &&
          ctx.user.role !== "specialist" &&
          ctx.user.role !== "admin"
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Only physicians, specialists, and admins can override allergy warnings",
          });
        }

        const db = getDb();
        const [flag] = await db
          .select()
          .from(clinicalFlags)
          .where(eq(clinicalFlags.id, input.flag_id))
          .limit(1);
        if (!flag) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Clinical flag ${input.flag_id} not found`,
          });
        }

        await enforcePatientAccess(ctx.user, flag.patient_id, undefined, ctx.clientIp);

        // If an allergy_id is supplied, verify it belongs to the SAME
        // patient as the flag. This blocks cross-patient override bleed
        // (an attacker passing a valid flag_id for patient A together with
        // a valid allergy_id for patient B to dilute the audit trail).
        // The row itself is retained for the allergen-name denormalisation
        // below (#905) — saves a second round-trip.
        let allergyRowForOverride:
          | { patient_id: string; allergen: string }
          | undefined;
        if (input.allergy_id) {
          const [allergyRow] = await db
            .select()
            .from(allergies)
            .where(eq(allergies.id, input.allergy_id))
            .limit(1);
          if (!allergyRow) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `Allergy ${input.allergy_id} not found`,
            });
          }
          if (allergyRow.patient_id !== flag.patient_id) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "allergy_id does not belong to the same patient as the flag",
            });
          }
          allergyRowForOverride = allergyRow;
        }

        const now = new Date().toISOString();
        const overrideId = crypto.randomUUID();

        // Summarised dismiss_reason keeps existing flag-inbox UIs working
        // even though the structured record lives in allergy_overrides.
        // Keep this below the flags.dismiss_reason column limit (2000).
        const dismissSummary =
          `Overridden (${input.override_reason}): ${input.clinical_justification}`.slice(
            0,
            2000,
          );

        // Denormalise the allergen / medication strings onto the override
        // row so the rule-layer suppression can read them directly rather
        // than regex-parsing the triggering flag's summary (#905). The
        // allergen prefers the structured allergies row (when supplied);
        // the medication is recovered from the flag summary which is
        // produced by `checkAllergyMedication` in a stable format:
        //   `Medication "<med>" matches patient allergy to "<allergen>"`
        //   `Medication "<med>" may cross-react with allergy to "<allergen>" ...`
        // A parse miss leaves the column NULL — downstream loader falls
        // back to the legacy summary parse so legacy rows still resolve.
        const summary = flag.summary ?? "";
        const medMatch = summary.match(/^Medication "([^"]+)"/);
        const allergenFromSummary = summary.match(/allergy to "([^"]+)"/);
        const medicationName = medMatch ? medMatch[1]! : null;
        const allergenName: string | null =
          allergyRowForOverride?.allergen ??
          (allergenFromSummary ? allergenFromSummary[1]! : null);

        await db.transaction(async (tx) => {
          await tx.insert(allergyOverrides).values({
            id: overrideId,
            patient_id: flag.patient_id,
            allergy_id: input.allergy_id ?? null,
            flag_id: input.flag_id,
            overridden_by: ctx.user.id,
            override_reason: input.override_reason,
            clinical_justification: input.clinical_justification,
            overridden_at: now,
            medication_name: medicationName,
            allergen_name: allergenName,
          });

          await tx
            .update(clinicalFlags)
            .set({
              status: "dismissed",
              dismissed_by: ctx.user.id,
              dismissed_at: now,
              dismiss_reason: dismissSummary,
            })
            .where(eq(clinicalFlags.id, input.flag_id));

          await tx.insert(auditLog).values({
            id: crypto.randomUUID(),
            user_id: ctx.user.id,
            action: "allergy_override",
            resource_type: "allergy_override",
            resource_id: overrideId,
            procedure_name: "allergies.override",
            patient_id: flag.patient_id,
            details: JSON.stringify({
              flag_id: input.flag_id,
              allergy_id: input.allergy_id ?? null,
              override_reason: input.override_reason,
              clinical_justification: input.clinical_justification,
            }),
            ip_address: ctx.clientIp ?? "",
            timestamp: now,
          });
        });

        return {
          id: overrideId,
          flag_id: input.flag_id,
          patient_id: flag.patient_id,
          allergy_id: input.allergy_id ?? null,
          overridden_by: ctx.user.id,
          override_reason: input.override_reason,
          clinical_justification: input.clinical_justification,
          overridden_at: now,
        };
      }),
  }),

  careTeam: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        // Care-team roster is part of the summary-tier read — a caregiver
        // who can see demographics can see who the patient's providers are.
        await enforcePatientAccess(ctx.user, input.patientId, "view_summary", ctx.clientIp);
        const db = getDb();
        return db
          .select()
          .from(careTeamMembers)
          .where(eq(careTeamMembers.patient_id, input.patientId));
      }),
  }),

  observations: t.router({
    getByPatient: protectedProcedure
      .input(
        z.object({
          patientId: z.string(),
          limit: z.number().optional().default(20),
        }),
      )
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId, "view_summary", ctx.clientIp);
        return listObservationsByPatient(input.patientId, input.limit);
      }),

    create: protectedProcedure
      .input(
        z.object({
          patientId: z.string(),
          observationType: z.enum([
            "pain",
            "neurological",
            "gastrointestinal",
            "respiratory",
            "skin",
            "cardiovascular",
            "general",
            "medication_side_effect",
          ]),
          description: z.string().min(1),
          structuredData: z
            .object({
              location: z.string().optional(),
              severity: z.number().min(1).max(10),
              duration: z.string().optional(),
              frequency: z.string().optional(),
              associated_activities: z.string().optional(),
            })
            .optional(),
          severitySelfAssessment: z
            .enum(["mild", "moderate", "severe"])
            .optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Patient-reported observations are an act of first-person self-report.
        // Family caregivers can *view* the symptom journal (via getByPatient +
        // enforcePatientAccess) but must never submit entries on the patient's
        // behalf — the clinical value of this feed depends on the patient
        // being the author. Enforce server-side so a tampered client can't
        // bypass the read-only UI.
        if (ctx.user.role === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Family caregivers cannot submit symptom observations on behalf of a patient",
          });
        }
        await enforcePatientAccess(ctx.user, input.patientId, undefined, ctx.clientIp);
        return createObservation(input);
      }),
  }),
});
