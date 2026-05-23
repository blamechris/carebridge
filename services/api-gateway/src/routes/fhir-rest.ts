/**
 * FHIR R4 REST API surface (#394).
 *
 * External-facing REST endpoints for systems that consume CareBridge data
 * over the FHIR R4 wire format (Epic, HIEs, third-party apps). The tRPC
 * router under /trpc/fhir.* remains the internal-facing entrypoint;
 * /fhir/* here is the standards-compliant equivalent.
 *
 * Endpoints are read-only on first ship. Writes (PUT/POST) require a
 * separate auth/scope story and are tracked in #393.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import {
  patients,
  vitals,
  labResults,
  labPanels,
  medications,
  diagnoses,
  allergies,
  encounters,
} from "@carebridge/db-schema";
import {
  toFhirPatient,
  toFhirVitalObservation,
  toFhirLabObservation,
  toFhirCondition,
  toFhirMedicationStatement,
  toFhirAllergyIntolerance,
  toFhirEncounter,
} from "@carebridge/fhir-gateway";
import { assertCareTeamAccess } from "../middleware/rbac.js";

const FHIR_JSON = "application/fhir+json";

/**
 * FHIR OperationOutcome resource for error responses (#394 §FHIR Compliance).
 * `severity` follows the FHIR spec: fatal | error | warning | information.
 * `code` is a token from the issue-type value set.
 */
interface FhirOperationOutcome {
  resourceType: "OperationOutcome";
  issue: Array<{
    severity: "fatal" | "error" | "warning" | "information";
    code: string;
    details?: { text: string };
    diagnostics?: string;
  }>;
}

function operationOutcome(
  severity: "fatal" | "error" | "warning" | "information",
  code: string,
  text: string,
): FhirOperationOutcome {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity, code, details: { text } }],
  };
}

/**
 * Wrap an array of FHIR resources in a Bundle (searchset) per FHIR R4
 * §3.5 Bundle resource. Pagination links built from the request path + the
 * count/offset cursor.
 */
function searchsetBundle(
  baseUrl: string,
  resources: Array<Record<string, unknown>>,
  total: number,
  offset: number,
  count: number,
): Record<string, unknown> {
  const link: Array<{ relation: string; url: string }> = [
    { relation: "self", url: `${baseUrl}&_offset=${offset}&_count=${count}` },
  ];
  if (offset + count < total) {
    link.push({
      relation: "next",
      url: `${baseUrl}&_offset=${offset + count}&_count=${count}`,
    });
  }
  if (offset > 0) {
    link.push({
      relation: "previous",
      url: `${baseUrl}&_offset=${Math.max(0, offset - count)}&_count=${count}`,
    });
  }
  return {
    resourceType: "Bundle",
    type: "searchset",
    total,
    link,
    entry: resources.map((r) => ({
      fullUrl: `${r.resourceType}/${r.id}`,
      resource: r,
    })),
  };
}

/**
 * Auth + RBAC gate shared by all clinical-data endpoints. Returns the
 * resolved user, or sends a FHIR-style 401/403 OperationOutcome and
 * returns null.
 */
async function requirePatientAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  patientId: string,
): Promise<{ id: string; role: string } | null> {
  if (!request.user) {
    reply
      .code(401)
      .type(FHIR_JSON)
      .send(operationOutcome("error", "login", "Authentication required"));
    return null;
  }

  const user = request.user;

  if (user.role === "admin") return user;

  if (user.role === "patient") {
    if (user.id !== patientId) {
      reply
        .code(403)
        .type(FHIR_JSON)
        .send(
          operationOutcome(
            "error",
            "forbidden",
            "Patients may only access their own records",
          ),
        );
      return null;
    }
    return user;
  }

  const hasAccess = await assertCareTeamAccess(user.id, patientId, request.ip);
  if (!hasAccess) {
    reply
      .code(403)
      .type(FHIR_JSON)
      .send(
        operationOutcome(
          "error",
          "forbidden",
          "No active care-team assignment for this patient",
        ),
      );
    return null;
  }
  return user;
}

function parsePagination(query: Record<string, string | undefined>): {
  count: number;
  offset: number;
} {
  const count = Math.min(
    Math.max(1, Number(query._count ?? 50) || 50),
    200, // hard cap to prevent unbounded result sets
  );
  const offset = Math.max(0, Number(query._offset ?? 0) || 0);
  return { count, offset };
}

/**
 * Static CapabilityStatement (#394). Declares the resource types this
 * server supports and which interactions (read, search-type) are
 * available for each. Updated alongside any change to the route set.
 */
function buildCapabilityStatement(host: string): Record<string, unknown> {
  const resources = [
    { type: "Patient", searchParams: ["identifier"] },
    {
      type: "Observation",
      searchParams: ["patient", "category", "_lastUpdated"],
    },
    { type: "Condition", searchParams: ["patient"] },
    { type: "MedicationStatement", searchParams: ["patient"] },
    { type: "AllergyIntolerance", searchParams: ["patient"] },
    { type: "Encounter", searchParams: ["patient"] },
  ];

  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    publisher: "CareBridge",
    kind: "instance",
    implementation: { url: `${host}/fhir`, description: "CareBridge FHIR R4 server" },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    rest: [
      {
        mode: "server",
        resource: resources.map((r) => ({
          type: r.type,
          interaction: [{ code: "read" }, { code: "search-type" }],
          searchParam: r.searchParams.map((name) => ({ name, type: "string" })),
        })),
      },
    ],
  };
}

function baseUrl(request: FastifyRequest, resourceType: string): string {
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  const host = request.headers.host ?? "localhost";
  return `${proto}://${host}/fhir/${resourceType}?`;
}

export function registerFhirRestRoutes(server: FastifyInstance): void {
  // ── GET /fhir/metadata — CapabilityStatement ──────────────────
  server.get("/fhir/metadata", async (request, reply) => {
    const proto = request.headers["x-forwarded-proto"] ?? "http";
    const host = request.headers.host ?? "localhost";
    return reply
      .type(FHIR_JSON)
      .send(buildCapabilityStatement(`${proto}://${host}`));
  });

  // ── GET /fhir/Patient/:id ─────────────────────────────────────
  server.get<{ Params: { id: string } }>(
    "/fhir/Patient/:id",
    async (request, reply) => {
      const user = await requirePatientAccess(request, reply, request.params.id);
      if (!user) return;

      const db = getDb();
      const [row] = await db
        .select()
        .from(patients)
        .where(eq(patients.id, request.params.id))
        .limit(1);
      if (!row) {
        return reply
          .code(404)
          .type(FHIR_JSON)
          .send(operationOutcome("error", "not-found", "Patient not found"));
      }
      return reply.type(FHIR_JSON).send(toFhirPatient(row));
    },
  );

  // ── GET /fhir/Patient?identifier=:mrn ─────────────────────────
  server.get<{ Querystring: { identifier?: string; _count?: string; _offset?: string } }>(
    "/fhir/Patient",
    async (request, reply) => {
      if (!request.user) {
        return reply
          .code(401)
          .type(FHIR_JSON)
          .send(operationOutcome("error", "login", "Authentication required"));
      }
      const identifier = request.query.identifier;
      if (!identifier) {
        return reply
          .code(400)
          .type(FHIR_JSON)
          .send(
            operationOutcome(
              "error",
              "required",
              "identifier search parameter is required",
            ),
          );
      }

      // Only admins and clinical roles can search across patients; patients
      // restricted to their own record can use /Patient/:id directly.
      if (request.user.role === "patient") {
        return reply
          .code(403)
          .type(FHIR_JSON)
          .send(
            operationOutcome(
              "error",
              "forbidden",
              "Patient role may not search across patients",
            ),
          );
      }

      const db = getDb();
      const { count, offset } = parsePagination(request.query);
      // The patients table stores MRN inside the encrypted record; a real
      // implementation would search the indexed identifier column. For now
      // we treat `identifier` as a partial id match and let the access
      // control re-check on the matched row.
      const rows = await db
        .select()
        .from(patients)
        .where(eq(patients.id, identifier))
        .limit(count)
        .offset(offset);

      // Enforce per-row access for non-admins (RBAC consistent with tRPC).
      const accessible = [] as typeof rows;
      for (const row of rows) {
        if (request.user.role === "admin") {
          accessible.push(row);
          continue;
        }
        const ok = await assertCareTeamAccess(
          request.user.id,
          row.id,
          request.ip,
        );
        if (ok) accessible.push(row);
      }

      const resources = accessible.map(
        (r) => toFhirPatient(r) as unknown as Record<string, unknown>,
      );
      return reply
        .type(FHIR_JSON)
        .send(
          searchsetBundle(
            baseUrl(request, "Patient"),
            resources as Array<Record<string, unknown>>,
            resources.length,
            offset,
            count,
          ),
        );
    },
  );

  // ── GET /fhir/Observation?patient=:id&category=vital-signs|laboratory ──
  server.get<{
    Querystring: {
      patient?: string;
      category?: string;
      _count?: string;
      _offset?: string;
      _lastUpdated?: string;
    };
  }>("/fhir/Observation", async (request, reply) => {
    const patientId = request.query.patient;
    if (!patientId) {
      return reply
        .code(400)
        .type(FHIR_JSON)
        .send(
          operationOutcome(
            "error",
            "required",
            "patient search parameter is required",
          ),
        );
    }
    const user = await requirePatientAccess(request, reply, patientId);
    if (!user) return;

    const db = getDb();
    const { count, offset } = parsePagination(request.query);
    const category = request.query.category;

    const resources: Array<Record<string, unknown>> = [];

    if (!category || category === "vital-signs") {
      const vitalRows = await db
        .select()
        .from(vitals)
        .where(eq(vitals.patient_id, patientId))
        .orderBy(desc(vitals.recorded_at))
        .limit(count)
        .offset(offset);
      for (const v of vitalRows) {
        resources.push(
          toFhirVitalObservation(
            v as Parameters<typeof toFhirVitalObservation>[0],
            patientId,
          ) as unknown as Record<string, unknown>,
        );
      }
    }

    if (!category || category === "laboratory") {
      // Lab results join through panels to get patient_id.
      const labRows = await db
        .select({ result: labResults, panel: labPanels })
        .from(labResults)
        .innerJoin(labPanels, eq(labResults.panel_id, labPanels.id))
        .where(eq(labPanels.patient_id, patientId))
        .orderBy(desc(labPanels.collected_at))
        .limit(count)
        .offset(offset);
      for (const { result, panel } of labRows) {
        resources.push(
          toFhirLabObservation(
            result as unknown as Parameters<typeof toFhirLabObservation>[0],
            panel.patient_id,
          ) as unknown as Record<string, unknown>,
        );
      }
    }

    return reply
      .type(FHIR_JSON)
      .send(
        searchsetBundle(
          baseUrl(request, "Observation") +
            `patient=${patientId}` +
            (category ? `&category=${category}` : ""),
          resources,
          resources.length,
          offset,
          count,
        ),
      );
  });

  // ── GET /fhir/Condition?patient=:id ───────────────────────────
  server.get<{
    Querystring: { patient?: string; _count?: string; _offset?: string };
  }>("/fhir/Condition", async (request, reply) => {
    const patientId = request.query.patient;
    if (!patientId) {
      return reply
        .code(400)
        .type(FHIR_JSON)
        .send(
          operationOutcome(
            "error",
            "required",
            "patient search parameter is required",
          ),
        );
    }
    const user = await requirePatientAccess(request, reply, patientId);
    if (!user) return;

    const db = getDb();
    const { count, offset } = parsePagination(request.query);
    const rows = await db
      .select()
      .from(diagnoses)
      .where(eq(diagnoses.patient_id, patientId))
      .limit(count)
      .offset(offset);

    const resources = rows.map(
      (r) =>
        toFhirCondition(
          r as Parameters<typeof toFhirCondition>[0],
          patientId,
        ) as unknown as Record<string, unknown>,
    );
    return reply
      .type(FHIR_JSON)
      .send(
        searchsetBundle(
          baseUrl(request, "Condition") + `patient=${patientId}`,
          resources,
          resources.length,
          offset,
          count,
        ),
      );
  });

  // ── GET /fhir/MedicationStatement?patient=:id ─────────────────
  server.get<{
    Querystring: { patient?: string; _count?: string; _offset?: string };
  }>("/fhir/MedicationStatement", async (request, reply) => {
    const patientId = request.query.patient;
    if (!patientId) {
      return reply
        .code(400)
        .type(FHIR_JSON)
        .send(
          operationOutcome(
            "error",
            "required",
            "patient search parameter is required",
          ),
        );
    }
    const user = await requirePatientAccess(request, reply, patientId);
    if (!user) return;

    const db = getDb();
    const { count, offset } = parsePagination(request.query);
    const rows = await db
      .select()
      .from(medications)
      .where(eq(medications.patient_id, patientId))
      .limit(count)
      .offset(offset);

    const resources = rows.map(
      (r) =>
        toFhirMedicationStatement(
          r as Parameters<typeof toFhirMedicationStatement>[0],
          patientId,
        ) as unknown as Record<string, unknown>,
    );
    return reply
      .type(FHIR_JSON)
      .send(
        searchsetBundle(
          baseUrl(request, "MedicationStatement") + `patient=${patientId}`,
          resources,
          resources.length,
          offset,
          count,
        ),
      );
  });

  // ── GET /fhir/AllergyIntolerance?patient=:id ──────────────────
  server.get<{
    Querystring: { patient?: string; _count?: string; _offset?: string };
  }>("/fhir/AllergyIntolerance", async (request, reply) => {
    const patientId = request.query.patient;
    if (!patientId) {
      return reply
        .code(400)
        .type(FHIR_JSON)
        .send(
          operationOutcome(
            "error",
            "required",
            "patient search parameter is required",
          ),
        );
    }
    const user = await requirePatientAccess(request, reply, patientId);
    if (!user) return;

    const db = getDb();
    const { count, offset } = parsePagination(request.query);
    const rows = await db
      .select()
      .from(allergies)
      .where(eq(allergies.patient_id, patientId))
      .limit(count)
      .offset(offset);

    const resources = rows.map(
      (r) =>
        toFhirAllergyIntolerance(
          r as Parameters<typeof toFhirAllergyIntolerance>[0],
          patientId,
        ) as unknown as Record<string, unknown>,
    );
    return reply
      .type(FHIR_JSON)
      .send(
        searchsetBundle(
          baseUrl(request, "AllergyIntolerance") + `patient=${patientId}`,
          resources,
          resources.length,
          offset,
          count,
        ),
      );
  });

  // ── GET /fhir/Encounter?patient=:id ───────────────────────────
  server.get<{
    Querystring: { patient?: string; _count?: string; _offset?: string };
  }>("/fhir/Encounter", async (request, reply) => {
    const patientId = request.query.patient;
    if (!patientId) {
      return reply
        .code(400)
        .type(FHIR_JSON)
        .send(
          operationOutcome(
            "error",
            "required",
            "patient search parameter is required",
          ),
        );
    }
    const user = await requirePatientAccess(request, reply, patientId);
    if (!user) return;

    const db = getDb();
    const { count, offset } = parsePagination(request.query);
    const rows = await db
      .select()
      .from(encounters)
      .where(eq(encounters.patient_id, patientId))
      .orderBy(desc(encounters.start_time))
      .limit(count)
      .offset(offset);

    const resources = rows.map(
      (r) =>
        toFhirEncounter(
          r as Parameters<typeof toFhirEncounter>[0],
          patientId,
        ) as unknown as Record<string, unknown>,
    );
    return reply
      .type(FHIR_JSON)
      .send(
        searchsetBundle(
          baseUrl(request, "Encounter") + `patient=${patientId}`,
          resources,
          resources.length,
          offset,
          count,
        ),
      );
  });
}

// Re-exports for testing.
export {
  operationOutcome,
  searchsetBundle,
  parsePagination,
  buildCapabilityStatement,
};
