/**
 * Unit tests for Epic config loading (#389).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  loadEpicConfig,
  EPIC_SANDBOX_TOKEN_URL,
  EPIC_SANDBOX_FHIR_BASE_URL,
} from "../config.js";

let tmpDir: string;
let pemPath: string;
let privatePem: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "carebridge-epic-config-"));
  pemPath = join(tmpDir, "epic-private.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(pemPath, privatePem, "utf8");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadEpicConfig (#389)", () => {
  it("loads from a complete env with explicit file path", () => {
    const cfg = loadEpicConfig({
      EPIC_CLIENT_ID: "abc-123",
      EPIC_PRIVATE_KEY_PATH: pemPath,
      EPIC_JWT_KID: "kid-001",
    });
    expect(cfg.clientId).toBe("abc-123");
    expect(cfg.jwtKid).toBe("kid-001");
    expect(cfg.privateKeyPem).toBe(privatePem);
  });

  it("defaults to sandbox URLs when EPIC_TOKEN_URL / EPIC_FHIR_BASE_URL absent", () => {
    const cfg = loadEpicConfig({
      EPIC_CLIENT_ID: "abc-123",
      EPIC_PRIVATE_KEY_PATH: pemPath,
      EPIC_JWT_KID: "kid-001",
    });
    expect(cfg.tokenUrl).toBe(EPIC_SANDBOX_TOKEN_URL);
    expect(cfg.fhirBaseUrl).toBe(EPIC_SANDBOX_FHIR_BASE_URL);
  });

  it("honours explicit EPIC_TOKEN_URL override (e.g. production)", () => {
    const cfg = loadEpicConfig({
      EPIC_CLIENT_ID: "abc-123",
      EPIC_PRIVATE_KEY_PATH: pemPath,
      EPIC_JWT_KID: "kid-001",
      EPIC_TOKEN_URL: "https://prod.example.com/oauth2/token",
      EPIC_FHIR_BASE_URL: "https://prod.example.com/api/FHIR/R4/",
    });
    expect(cfg.tokenUrl).toBe("https://prod.example.com/oauth2/token");
    expect(cfg.fhirBaseUrl).toBe("https://prod.example.com/api/FHIR/R4/");
  });

  it("throws when EPIC_CLIENT_ID is missing", () => {
    expect(() =>
      loadEpicConfig({
        EPIC_PRIVATE_KEY_PATH: pemPath,
        EPIC_JWT_KID: "kid-001",
      }),
    ).toThrow();
  });

  it("throws when EPIC_JWT_KID is missing", () => {
    expect(() =>
      loadEpicConfig({
        EPIC_CLIENT_ID: "abc-123",
        EPIC_PRIVATE_KEY_PATH: pemPath,
      }),
    ).toThrow();
  });

  it("throws when neither PATH nor PEM is set", () => {
    expect(() =>
      loadEpicConfig({
        EPIC_CLIENT_ID: "abc-123",
        EPIC_JWT_KID: "kid-001",
      }),
    ).toThrow(/EPIC_PRIVATE_KEY_PATH or EPIC_PRIVATE_KEY_PEM/);
  });

  it("throws when PATH points at a non-existent file", () => {
    expect(() =>
      loadEpicConfig({
        EPIC_CLIENT_ID: "abc-123",
        EPIC_PRIVATE_KEY_PATH: join(tmpDir, "does-not-exist.pem"),
        EPIC_JWT_KID: "kid-001",
      }),
    ).toThrow(/Failed to read EPIC_PRIVATE_KEY_PATH/);
  });

  it("accepts inline PEM when PATH is absent", () => {
    const cfg = loadEpicConfig({
      EPIC_CLIENT_ID: "abc-123",
      EPIC_PRIVATE_KEY_PEM: privatePem,
      EPIC_JWT_KID: "kid-001",
    });
    expect(cfg.privateKeyPem).toBe(privatePem);
  });

  it("prefers PATH over PEM when both are set", () => {
    const altPem =
      "-----BEGIN PRIVATE KEY-----\nfake-different-key\n-----END PRIVATE KEY-----";
    const cfg = loadEpicConfig({
      EPIC_CLIENT_ID: "abc-123",
      EPIC_PRIVATE_KEY_PATH: pemPath,
      EPIC_PRIVATE_KEY_PEM: altPem,
      EPIC_JWT_KID: "kid-001",
    });
    expect(cfg.privateKeyPem).toBe(privatePem); // came from PATH, not PEM
  });

  it("rejects a key that isn't a PEM-encoded RSA private key", () => {
    const bogus = join(tmpDir, "not-a-key.pem");
    writeFileSync(bogus, "this is not a key", "utf8");
    expect(() =>
      loadEpicConfig({
        EPIC_CLIENT_ID: "abc-123",
        EPIC_PRIVATE_KEY_PATH: bogus,
        EPIC_JWT_KID: "kid-001",
      }),
    ).toThrow(/private key must be a PEM/);
  });
});
