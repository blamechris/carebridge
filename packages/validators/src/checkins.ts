import { z } from "zod";

/**
 * Shape of a single question in a check-in template. Mirrors
 * `CheckInQuestion` in @carebridge/db-schema but lives here because
 * validators are the one package the apps and services both depend
 * on for runtime shape-checking.
 */
export const checkInQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1).max(500),
  type: z.enum(["boolean", "scale", "number", "select", "multi", "text"]),
  required: z.boolean().optional(),
  options: z
    .array(
      z.object({
        value: z.string().min(1).max(64),
        label: z.string().min(1).max(200),
      }),
    )
    .optional(),
  red_flag: z
    .union([
      z.object({ kind: z.literal("bool"), when: z.boolean() }),
      z.object({
        kind: z.literal("threshold"),
        gte: z.number().optional(),
        lte: z.number().optional(),
      }),
      z.object({
        kind: z.literal("values"),
        values: z.array(z.string().min(1).max(64)).min(1),
      }),
    ])
    .optional(),
});

export type CheckInQuestion = z.infer<typeof checkInQuestionSchema>;

/**
 * Permitted answer shapes, keyed by question id. The form renderer
 * produces the right primitive per question type; the review worker
 * type-narrows before applying red-flag rules.
 */
export const checkInResponseValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string().max(2000), // free-text length cap — sanitised before storage
  z.array(z.string().max(64)).max(32),
]);

export const checkInResponsesSchema = z.record(
  z.string().min(1).max(64),
  checkInResponseValueSchema,
);

export type CheckInResponses = z.infer<typeof checkInResponsesSchema>;

/**
 * Relationship taxonomy for the submitter. "self" is the common case;
 * the others are populated via the Phase B3 family-access flow.
 */
export const checkInRelationshipSchema = z.enum([
  "self",
  "spouse",
  "adult_child",
  "parent",
  "healthcare_poa",
  "other",
]);

export type CheckInRelationship = z.infer<typeof checkInRelationshipSchema>;

/**
 * Client-facing submission payload. The patient portal sends this to
 * the api-gateway; submitter identity is intentionally absent because
 * the gateway pulls it from the authenticated session, not from the
 * client.
 */
export const submitCheckInSchema = z.object({
  patient_id: z.string().uuid(),
  template_id: z.string().uuid(),
  /**
   * Client echoes the version it rendered so the server can reject
   * submissions written against a retired template version rather
   * than silently coercing them.
   */
  template_version: z.number().int().positive(),
  responses: checkInResponsesSchema,
});

export type SubmitCheckInInput = z.infer<typeof submitCheckInSchema>;

/**
 * Service-side submission payload. The api-gateway wrapper stamps
 * `submitted_by_user_id` and `submitted_by_relationship` from the
 * authenticated session and forwards this shape to the standalone
 * `@carebridge/checkins` router. The standalone router accepts these
 * as inputs so it stays context-less (matching the existing
 * `@carebridge/fhir-gateway` -> api-gateway wrapping pattern).
 */
export const submitCheckInServiceSchema = submitCheckInSchema.extend({
  submitted_by_user_id: z.string().uuid(),
  submitted_by_relationship: checkInRelationshipSchema,
});

export type SubmitCheckInServiceInput = z.infer<
  typeof submitCheckInServiceSchema
>;
