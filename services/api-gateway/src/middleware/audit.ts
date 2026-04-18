import type { FastifyRequest, FastifyReply } from "fastify";
import type { User } from "@carebridge/shared-types";
import {
  getDb,
  auditLog,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";

/** Map HTTP methods to human-readable actions. */
function methodToAction(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "read";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return method.toLowerCase();
  }
}

/**
 * Extract resource_type and resource_id from a URL path.
 *
 * Expected patterns:
 *   /trpc/patients.getById  -> { resourceType: "patients", resourceId: "" }
 *   /api/patients/pat-123   -> { resourceType: "patients", resourceId: "pat-123" }
 *   /health                 -> { resourceType: "system", resourceId: "" }
 */
function parseResource(url: string): { resourceType: string; resourceId: string } {
  // tRPC style: /trpc/<router>.<procedure>
  const trpcMatch = url.match(/\/trpc\/([^.?/]+)/);
  if (trpcMatch) {
    return { resourceType: trpcMatch[1]!, resourceId: "" };
  }

  // REST style: /<resource>/<id>
  const segments = url.replace(/\?.*$/, "").split("/").filter(Boolean);
  if (segments.length >= 2) {
    return { resourceType: segments[0]!, resourceId: segments[1]! };
  }

  if (segments.length === 1) {
    return { resourceType: segments[0]!, resourceId: "" };
  }

  return { resourceType: "system", resourceId: "" };
}

/**
 * Extract the full tRPC procedure name from a URL path.
 *
 * tRPC encodes the procedure as the path segment after "/trpc/":
 *   /trpc/patients.getById      -> "patients.getById"
 *   /trpc/vitals.create?batch=1 -> "vitals.create"
 *
 * Returns null for non-tRPC URLs.
 */
function parseProcedureName(url: string): string | null {
  // Strip query string, then match everything after /trpc/
  const match = url.replace(/\?.*$/, "").match(/\/trpc\/(.+)/);
  return match ? match[1]! : null;
}

/**
 * Attempt to extract a patientId from the parsed tRPC request body.
 *
 * tRPC POST bodies come in two shapes depending on batch mode:
 *   Batched:  { "0": { json: { patientId: "...", ... } } }
 *   Single:   { json: { patientId: "...", ... } }
 *
 * As a fallback the flat-input shape is also checked:
 *   { patientId: "..." }
 */
function extractPatientId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;

  // Helper: dig into a single tRPC input envelope.
  function fromEnvelope(envelope: unknown): string | null {
    if (!envelope || typeof envelope !== "object") return null;
    const e = envelope as Record<string, unknown>;

    // { json: { patientId, input: { patientId } } }
    const json = e["json"];
    if (json && typeof json === "object") {
      const j = json as Record<string, unknown>;
      if (typeof j["patientId"] === "string") return j["patientId"];
      const input = j["input"];
      if (input && typeof input === "object") {
        const i = input as Record<string, unknown>;
        if (typeof i["patientId"] === "string") return i["patientId"];
      }
    }

    // Flat: { patientId } or { input: { patientId } }
    if (typeof e["patientId"] === "string") return e["patientId"];
    const input = e["input"];
    if (input && typeof input === "object") {
      const i = input as Record<string, unknown>;
      if (typeof i["patientId"] === "string") return i["patientId"];
    }

    return null;
  }

  // Array shape (batched tRPC)
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = fromEnvelope(item);
      if (found) return found;
    }
    return null;
  }

  // Object shape — try numeric keys first ("0", "1", ...) then the object itself.
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (/^\d+$/.test(key)) {
      const found = fromEnvelope(b[key]);
      if (found) return found;
    }
  }

  return fromEnvelope(body);
}

/**
 * Look up the relationship_type a family caregiver has with a patient.
 *
 * `family_relationships.patient_id` references the *patient user's* id, but
 * requests identify the subject by *patient record* id, so this joins through
 * the users table to resolve the link.
 *
 * Returns null when no active relationship exists — callers should treat that
 * as a silent denial for audit purposes (the request itself is rejected
 * elsewhere; the audit log still needs to record that a caregiver attempted
 * it without a valid relationship).
 */
export async function getFamilyRelationshipType(
  caregiverUserId: string,
  patientRecordId: string,
): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ relationship_type: familyRelationships.relationship_type })
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
  return row?.relationship_type ?? null;
}

/**
 * Derive actor_relationship / on_behalf_of_patient_id for the audit row.
 *
 * - patient           → "self" ONLY when the target is the patient's own
 *                       record (patientId absent, or matches user.patient_id).
 *                       A patient requesting a different patient's record is
 *                       a cross-patient access attempt — actorRelationship
 *                       stays null so the audit trail doesn't mislabel it.
 * - family_caregiver  → active relationship_type from family_relationships
 *                       ("spouse", "parent", ...). Falls back to the literal
 *                       "caregiver" when patientId is missing or no active
 *                       relationship row exists. on_behalf_of_patient_id is
 *                       the requested patient record id when available.
 * - clinician / admin → both fields null (no relationship semantics).
 *
 * Exported so it can be unit-tested without the Fastify request machinery.
 */
export async function deriveActorContext(
  user: User | undefined,
  patientId: string | null,
): Promise<{
  actorRelationship: string | null;
  onBehalfOfPatientId: string | null;
}> {
  if (!user) {
    return { actorRelationship: null, onBehalfOfPatientId: null };
  }

  if (user.role === "patient") {
    if (!patientId || patientId === user.patient_id) {
      return { actorRelationship: "self", onBehalfOfPatientId: null };
    }
    // Cross-patient attempt by a patient account — leave relationship null
    // so reviewers can distinguish self-access from denied cross-access.
    return { actorRelationship: null, onBehalfOfPatientId: null };
  }

  if ((user.role as string) === "family_caregiver") {
    if (!patientId) {
      return { actorRelationship: "caregiver", onBehalfOfPatientId: null };
    }
    const relationship = await getFamilyRelationshipType(user.id, patientId);
    return {
      actorRelationship: relationship ?? "caregiver",
      onBehalfOfPatientId: patientId,
    };
  }

  return { actorRelationship: null, onBehalfOfPatientId: null };
}

/**
 * Map an HTTP status code to a short, human-readable reason phrase.
 *
 * HIPAA § 164.312(b) requires audit controls sufficient to distinguish
 * successful access from denials and failures. Storing both the numeric
 * status and a short phrase makes it cheap to query for attack patterns
 * (e.g. repeated 401/403 probes from the same user) without having to
 * re-derive meaning from the integer alone.
 */
function statusCodeToMessage(statusCode: number): string | null {
  if (statusCode < 400) return null;
  switch (statusCode) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 409:
      return "Conflict";
    case 412:
      return "Precondition Failed";
    case 422:
      return "Unprocessable Entity";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    case 504:
      return "Gateway Timeout";
    default:
      if (statusCode >= 500) return "Server Error";
      return "Client Error";
  }
}

/**
 * Fastify onResponse hook that writes an entry to the audit_log table.
 *
 * Runs after the response has been sent so it does not block the client.
 * The Fastify tRPC plugin surfaces tRPC error codes as standard HTTP
 * status codes on `reply.statusCode` (UNAUTHORIZED -> 401, FORBIDDEN -> 403,
 * NOT_FOUND -> 404, etc.), so we can record the outcome uniformly for
 * both tRPC and REST routes.
 */
export async function auditMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Skip health-check noise.
  if (request.url === "/health") {
    return;
  }

  const user = request.user;
  const userId = user?.id ?? "anonymous";

  const action = methodToAction(request.method);
  const { resourceType, resourceId } = parseResource(request.url);
  const procedureName = parseProcedureName(request.url);
  const patientId = extractPatientId(request.body);

  const statusCode = reply.statusCode;
  // Treat 2xx and 3xx as success — redirects/304s are not failures and the
  // schema's error_message column is for "short failure reason for non-2xx"
  // failures only. Per Copilot review on PR #376.
  const success = statusCode >= 200 && statusCode < 400;
  const errorMessage = success ? null : statusCodeToMessage(statusCode);

  // Never let derivation failure drop the audit row — fall back to nulls.
  let actorRelationship: string | null = null;
  let onBehalfOfPatientId: string | null = null;
  try {
    const ctx = await deriveActorContext(user, patientId);
    actorRelationship = ctx.actorRelationship;
    onBehalfOfPatientId = ctx.onBehalfOfPatientId;
  } catch (err) {
    request.log.warn({ err }, "Failed to derive audit actor context");
  }

  const db = getDb();

  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      user_id: userId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      procedure_name: procedureName,
      patient_id: patientId,
      actor_relationship: actorRelationship,
      on_behalf_of_patient_id: onBehalfOfPatientId,
      ip_address: request.ip,
      http_status_code: statusCode,
      success,
      error_message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Audit logging should never crash the request cycle.
    request.log.error({ err }, "Failed to write audit log entry");
  }
}
