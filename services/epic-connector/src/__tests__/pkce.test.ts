/**
 * PKCE helper tests (#392).
 *
 * Verifies the implementation against RFC 7636 §4.6:
 *   verifier:  43-128 chars from [A-Z][a-z][0-9]-._~
 *   challenge: BASE64URL(SHA256(verifier))
 *   method:    "S256" (we don't support "plain")
 */
import { describe, it, expect } from "vitest";
import { generatePkcePair, verifyChallenge } from "../app-launch/pkce.js";
import { createHash } from "node:crypto";

describe("PKCE (#392)", () => {
  it("generates a 43-char verifier with only URL-safe characters", () => {
    const { codeVerifier } = generatePkcePair();
    expect(codeVerifier.length).toBe(43);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the challenge as base64url(SHA-256(verifier))", () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const expected = createHash("sha256")
      .update(codeVerifier)
      .digest("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(codeChallenge).toBe(expected);
  });

  it("always uses the S256 challenge method (Epic rejects 'plain')", () => {
    const { codeChallengeMethod } = generatePkcePair();
    expect(codeChallengeMethod).toBe("S256");
  });

  it("verifyChallenge returns true for a matching pair, false otherwise", () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    expect(verifyChallenge(codeVerifier, codeChallenge)).toBe(true);
    expect(verifyChallenge(codeVerifier, "tampered_challenge")).toBe(false);
    expect(verifyChallenge("tampered_verifier", codeChallenge)).toBe(false);
  });

  it("produces distinct pairs on subsequent calls", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  it("accepts an injected RNG for deterministic test fixtures", () => {
    const fakeRng = (size: number) => Buffer.alloc(size, 0x41); // 'A' bytes
    const pair = generatePkcePair(fakeRng);
    // 32 0x41 bytes base64-encode to "QUFB" repeated 10 times + "QUFBQQ"
    // (the trailing "==" is stripped per base64url).
    expect(pair.codeVerifier).toBe(
      "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE",
    );
    expect(pair.codeVerifier.length).toBe(43);
    expect(verifyChallenge(pair.codeVerifier, pair.codeChallenge)).toBe(true);
  });
});
