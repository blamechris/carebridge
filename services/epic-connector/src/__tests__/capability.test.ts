/**
 * Unit tests for SMART configuration discovery (#389).
 */
import { describe, it, expect, vi } from "vitest";
import {
  fetchSmartConfiguration,
  smartConfigurationUrl,
} from "../capability.js";

describe("smartConfigurationUrl (#389)", () => {
  it("appends /.well-known/smart-configuration to a base URL", () => {
    expect(
      smartConfigurationUrl("https://fhir.example.com/api/FHIR/R4/"),
    ).toBe("https://fhir.example.com/api/FHIR/R4/.well-known/smart-configuration");
  });

  it("normalises trailing slashes", () => {
    expect(
      smartConfigurationUrl("https://fhir.example.com/api/FHIR/R4////"),
    ).toBe("https://fhir.example.com/api/FHIR/R4/.well-known/smart-configuration");
  });
});

describe("fetchSmartConfiguration (#389)", () => {
  it("returns the parsed JSON on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token_endpoint: "https://fhir.example.com/oauth2/token",
          grant_types_supported: ["client_credentials"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const cfg = await fetchSmartConfiguration(
      "https://fhir.example.com/api/FHIR/R4/",
      fetchMock,
    );
    expect(cfg.token_endpoint).toBe("https://fhir.example.com/oauth2/token");
  });

  it("throws on non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    await expect(
      fetchSmartConfiguration(
        "https://fhir.example.com/api/FHIR/R4/",
        fetchMock,
      ),
    ).rejects.toThrow(/SMART configuration discovery failed: 404/);
  });

  it("throws when token_endpoint is missing from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ grant_types_supported: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      fetchSmartConfiguration(
        "https://fhir.example.com/api/FHIR/R4/",
        fetchMock,
      ),
    ).rejects.toThrow(/missing token_endpoint/);
  });
});
