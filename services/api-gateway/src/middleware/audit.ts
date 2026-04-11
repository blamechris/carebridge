import type { FastifyRequest, FastifyReply } from "fastify";
import type { User } from "@carebridge/shared-types";
import { getDb } from "@carebridge/db-schema";
import { auditLog } from "@carebridge/db-schema";
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

  const user = (request as unknown as Record<string, unknown>).user as User | undefined;
  const userId = user?.id ?? "anonymous";

  const action = methodToAction(request.method);
  const { resourceType, resourceId } = parseResource(request.url);
  const procedureName = parseProcedureName(request.url);
  const patientId = extractPatientId(request.body);

  const statusCode = reply.statusCode;
  const success = statusCode >= 200 && statusCode < 300;
  const errorMessage = success ? null : statusCodeToMessage(statusCode);

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
