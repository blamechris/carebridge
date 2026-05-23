/**
 * Unit tests for the FHIR REST surface helpers (#394).
 *
 * The route handlers themselves are exercised via integration tests against
 * a live Fastify instance with mocked DB / RBAC. These tests cover the pure
 * helpers — bundle assembly, pagination link generation, error shaping, and
 * the CapabilityStatement — because those are the FHIR-conformance-critical
 * pieces a conformance test suite (Inferno, Touchstone) will scrutinise.
 */
import { describe, it, expect } from "vitest";
import {
  operationOutcome,
  searchsetBundle,
  parsePagination,
  buildCapabilityStatement,
} from "../routes/fhir-rest.js";

describe("operationOutcome (#394)", () => {
  it("returns a FHIR R4 OperationOutcome shape", () => {
    const oo = operationOutcome("error", "not-found", "Patient not found");
    expect(oo.resourceType).toBe("OperationOutcome");
    expect(oo.issue).toHaveLength(1);
    expect(oo.issue[0]!.severity).toBe("error");
    expect(oo.issue[0]!.code).toBe("not-found");
    expect(oo.issue[0]!.details?.text).toBe("Patient not found");
  });

  it("supports all severity levels", () => {
    for (const sev of ["fatal", "error", "warning", "information"] as const) {
      const oo = operationOutcome(sev, "informational", "msg");
      expect(oo.issue[0]!.severity).toBe(sev);
    }
  });
});

describe("searchsetBundle (#394)", () => {
  const base = "https://example.test/fhir/Patient?";

  it("wraps resources in a Bundle with type=searchset and entry list", () => {
    const bundle = searchsetBundle(
      base,
      [
        { resourceType: "Patient", id: "p1" },
        { resourceType: "Patient", id: "p2" },
      ],
      2,
      0,
      50,
    );
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("searchset");
    expect(bundle.total).toBe(2);
    expect(bundle.entry).toEqual([
      { fullUrl: "Patient/p1", resource: { resourceType: "Patient", id: "p1" } },
      { fullUrl: "Patient/p2", resource: { resourceType: "Patient", id: "p2" } },
    ]);
  });

  it("emits a self link", () => {
    const bundle = searchsetBundle(base, [], 0, 0, 50);
    const link = bundle.link as Array<{ relation: string; url: string }>;
    expect(link[0]).toEqual({
      relation: "self",
      url: "https://example.test/fhir/Patient?&_offset=0&_count=50",
    });
  });

  it("emits next link when more results remain (offset + count < total)", () => {
    const bundle = searchsetBundle(base, [], 100, 0, 50);
    const link = bundle.link as Array<{ relation: string; url: string }>;
    expect(link.find((l) => l.relation === "next")?.url).toBe(
      "https://example.test/fhir/Patient?&_offset=50&_count=50",
    );
  });

  it("omits next link when at end of result set", () => {
    const bundle = searchsetBundle(base, [], 50, 0, 50);
    const link = bundle.link as Array<{ relation: string; url: string }>;
    expect(link.find((l) => l.relation === "next")).toBeUndefined();
  });

  it("emits previous link when offset > 0", () => {
    const bundle = searchsetBundle(base, [], 100, 50, 50);
    const link = bundle.link as Array<{ relation: string; url: string }>;
    expect(link.find((l) => l.relation === "previous")?.url).toBe(
      "https://example.test/fhir/Patient?&_offset=0&_count=50",
    );
  });

  it("clamps previous offset to 0 (no negative offsets)", () => {
    const bundle = searchsetBundle(base, [], 100, 25, 50);
    const link = bundle.link as Array<{ relation: string; url: string }>;
    // 25 - 50 would be -25; helper should clamp to 0
    expect(link.find((l) => l.relation === "previous")?.url).toBe(
      "https://example.test/fhir/Patient?&_offset=0&_count=50",
    );
  });
});

describe("parsePagination (#394)", () => {
  it("defaults to count=50, offset=0 when params absent", () => {
    expect(parsePagination({})).toEqual({ count: 50, offset: 0 });
  });

  it("parses numeric _count and _offset", () => {
    expect(parsePagination({ _count: "25", _offset: "10" })).toEqual({
      count: 25,
      offset: 10,
    });
  });

  it("clamps count to 1 minimum (zero or negative falls back to default 50)", () => {
    expect(parsePagination({ _count: "0" }).count).toBeGreaterThanOrEqual(1);
    expect(parsePagination({ _count: "-5" }).count).toBeGreaterThanOrEqual(1);
  });

  it("clamps count to 200 maximum (unbounded queries blocked)", () => {
    expect(parsePagination({ _count: "1000" })).toEqual({
      count: 200,
      offset: 0,
    });
  });

  it("clamps offset to 0 minimum", () => {
    expect(parsePagination({ _offset: "-10" })).toEqual({
      count: 50,
      offset: 0,
    });
  });

  it("falls back to defaults for non-numeric input", () => {
    expect(parsePagination({ _count: "abc", _offset: "xyz" })).toEqual({
      count: 50,
      offset: 0,
    });
  });
});

describe("CapabilityStatement (#394)", () => {
  it("declares FHIR R4 server with json format", () => {
    const cs = buildCapabilityStatement("https://example.test");
    expect(cs.resourceType).toBe("CapabilityStatement");
    expect(cs.status).toBe("active");
    expect(cs.kind).toBe("instance");
    expect(cs.fhirVersion).toBe("4.0.1");
    expect(cs.format).toContain("application/fhir+json");
  });

  it("advertises the resource types currently served by /fhir/*", () => {
    const cs = buildCapabilityStatement("https://example.test");
    const rest = cs.rest as Array<{
      mode: string;
      resource: Array<{ type: string; interaction: Array<{ code: string }> }>;
    }>;
    const types = rest[0]!.resource.map((r) => r.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "Patient",
        "Observation",
        "Condition",
        "MedicationStatement",
        "AllergyIntolerance",
        "Encounter",
      ]),
    );
  });

  it("declares both read and search-type interactions per resource", () => {
    const cs = buildCapabilityStatement("https://example.test");
    const rest = cs.rest as Array<{
      resource: Array<{ interaction: Array<{ code: string }> }>;
    }>;
    for (const r of rest[0]!.resource) {
      const codes = r.interaction.map((i) => i.code);
      expect(codes).toContain("read");
      expect(codes).toContain("search-type");
    }
  });

  it("includes the implementation.url derived from the host argument", () => {
    const cs = buildCapabilityStatement("https://carebridge.test");
    const impl = cs.implementation as { url: string; description: string };
    expect(impl.url).toBe("https://carebridge.test/fhir");
  });
});
