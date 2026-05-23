/**
 * Unit tests for the RS384 keypair generator (#389).
 *
 * These exercise the JWK conversion against a known-good RSA keypair
 * and verify the file-permissions / structure of the on-disk output.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateKeyPairSync,
  createSign,
  createVerify,
  createPublicKey,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, publicKeyFingerprint } from "../keygen.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "carebridge-epic-keygen-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateKeypair (#389)", () => {
  it("writes the private key to the requested path", () => {
    const out = join(tmpDir, "epic-private.pem");
    const result = generateKeypair({ privateKeyPath: out });
    expect(result.privateKeyPath).toBe(out);
    const pem = readFileSync(out, "utf8");
    expect(pem).toContain("BEGIN PRIVATE KEY");
  });

  it("sets the private key file mode to 0600 (owner-only)", () => {
    const out = join(tmpDir, "epic-private.pem");
    generateKeypair({ privateKeyPath: out });
    const mode = statSync(out).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates intermediate directories", () => {
    const out = join(tmpDir, "nested", "dir", "epic-private.pem");
    generateKeypair({ privateKeyPath: out });
    expect(readFileSync(out, "utf8")).toContain("BEGIN PRIVATE KEY");
  });

  it("returns a JWK with kty=RSA, alg=RS384, use=sig", () => {
    const result = generateKeypair({ privateKeyPath: join(tmpDir, "k.pem") });
    expect(result.publicJwk.kty).toBe("RSA");
    expect(result.publicJwk.alg).toBe("RS384");
    expect(result.publicJwk.use).toBe("sig");
  });

  it("uses the provided kid", () => {
    const kid = "my-rotation-2026-01";
    const result = generateKeypair({
      privateKeyPath: join(tmpDir, "k.pem"),
      kid,
    });
    expect(result.publicJwk.kid).toBe(kid);
    expect(result.kid).toBe(kid);
  });

  it("generates a JWK that verifies signatures made with the private key", () => {
    const result = generateKeypair({ privateKeyPath: join(tmpDir, "k.pem") });
    const privatePem = readFileSync(result.privateKeyPath, "utf8");

    // Sign arbitrary data with the generated private key, then verify
    // with a public key reconstructed from the JWK. This is the
    // round-trip Epic does server-side when it receives our assertion.
    const signer = createSign("RSA-SHA384");
    signer.update("test-payload");
    signer.end();
    const sig = signer.sign(privatePem);

    const publicKey = createPublicKey({
      key: { ...result.publicJwk } as Record<string, string>,
      format: "jwk",
    });
    const verifier = createVerify("RSA-SHA384");
    verifier.update("test-payload");
    verifier.end();
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });

  it("emits base64url-encoded n and e (no padding, URL-safe alphabet)", () => {
    const result = generateKeypair({ privateKeyPath: join(tmpDir, "k.pem") });
    // base64url: A-Z, a-z, 0-9, -, _ — no =, +, /
    expect(result.publicJwk.n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.publicJwk.e).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("honours an injected generator (test injection)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const privatePem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const publicPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    const result = generateKeypair({
      privateKeyPath: join(tmpDir, "k.pem"),
      generator: () => ({ privatePem, publicPem }),
    });

    // Writing the injected private key should produce a JWK whose
    // public key matches the injected public key.
    const reconstructed = createPublicKey({
      key: { ...result.publicJwk } as Record<string, string>,
      format: "jwk",
    });
    const reconstructedPem = reconstructed
      .export({ type: "spki", format: "pem" })
      .toString();
    expect(reconstructedPem).toBe(publicPem);
  });
});

describe("publicKeyFingerprint (#389)", () => {
  it("returns a 16-char hex prefix of the SHA-256 DER fingerprint", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const fp = publicKeyFingerprint(pem);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same key", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(publicKeyFingerprint(pem)).toBe(publicKeyFingerprint(pem));
  });
});
