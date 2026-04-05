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
 * Fastify onResponse hook that writes an entry to the audit_log table.
 *
 * Runs after the response has been sent so it does not block the client.
 */
export async function auditMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // Skip health-check noise.
  if (request.url === "/health") {
    return;
  }

  const user = (request as unknown as Record<string, unknown>).user as User | undefined;
  const userId = user?.id ?? "anonymous";

  const action = methodToAction(request.method);
  const { resourceType, resourceId } = parseResource(request.url);

  const db = getDb();

  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      user_id: userId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      ip_address: request.ip,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Audit logging should never crash the request cycle.
    request.log.error({ err }, "Failed to write audit log entry");
  }
}
