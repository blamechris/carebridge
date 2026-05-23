/**
 * Unit tests for the RS384 JWT assertion builder (#389).
 *
 * These verify the JWT against a fixture keypair generated inside the
 * test (no Epic call). The verification step uses Node's crypto with
 * the matching public key to confirm the signature is RS384 and that
 * the payload claims are spec-compliant.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeyPairSync,
  createVerify,
  KeyObject,
  randomUUID,
} from "node:crypto";
import {
  buildClientAssertion,
  decodeAssertionForTest,
} from "../jwt-assertion.js";

describe("buildClientAssertion (#389)", () => {
  let privateKeyPem: string;
  let publicKey: KeyObject;

  beforeAll(() => {
    const { privateKey, publicKey: pub } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKey = pub;
  });

  function makeArgs(overrides: Partial<Parameters<typeof buildClientAssertion>[0]> = {}) {
    return {
      clientId: "test-client-id-123",
      tokenUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
      kid: "test-kid-abc",
      privateKeyPem,
      ...overrides,
    };
  }

  it("emits a compact JWS with three segments", () => {
    const jwt = buildClientAssertion(makeArgs());
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("uses RS384 algorithm and includes the kid in the header", () => {
    const jwt = buildClientAssertion(makeArgs());
    const { header } = decodeAssertionForTest(jwt);
    expect(header.alg).toBe("RS384");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("test-kid-abc");
  });

  it("sets iss and sub to the client_id per Backend Services spec", () => {
    const jwt = buildClientAssertion(makeArgs());
    const { payload } = decodeAssertionForTest(jwt);
    expect(payload.iss).toBe("test-client-id-123");
    expect(payload.sub).toBe("test-client-id-123");
  });

  it("binds aud to the token endpoint URL", () => {
    const jwt = buildClientAssertion(makeArgs());
    const { payload } = decodeAssertionForTest(jwt);
    expect(payload.aud).toBe(
      "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
    );
  });

  it("sets exp to iat + 240s by default (under Epic's 5-minute ceiling)", () => {
    const fixedNow = 1_700_000_000;
    const jwt = buildClientAssertion(makeArgs({ now: () => fixedNow }));
    const { payload } = decodeAssertionForTest(jwt);
    expect(payload.iat).toBe(fixedNow);
    expect(payload.exp).toBe(fixedNow + 240);
  });

  it("honours the expiresInSec override", () => {
    const fixedNow = 1_700_000_000;
    const jwt = buildClientAssertion(
      makeArgs({ now: () => fixedNow, expiresInSec: 60 }),
    );
    const { payload } = decodeAssertionForTest(jwt);
    expect(payload.exp).toBe(fixedNow + 60);
  });

  it("includes a unique jti claim", () => {
    const a = decodeAssertionForTest(buildClientAssertion(makeArgs()));
    const b = decodeAssertionForTest(buildClientAssertion(makeArgs()));
    expect(a.payload.jti).toBeDefined();
    expect(b.payload.jti).toBeDefined();
    expect(a.payload.jti).not.toBe(b.payload.jti);
  });

  it("honours an injected jti", () => {
    const jti = randomUUID();
    const jwt = buildClientAssertion(makeArgs({ jti }));
    const { payload } = decodeAssertionForTest(jwt);
    expect(payload.jti).toBe(jti);
  });

  it("produces an RS384 signature verifiable with the matching public key", () => {
    const jwt = buildClientAssertion(makeArgs());
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    const signingInput = `${header}.${payload}`;

    const sigBuf = Buffer.from(
      signature.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (signature.length % 4)) % 4),
      "base64",
    );

    const verifier = createVerify("RSA-SHA384");
    verifier.update(signingInput);
    verifier.end();
    const ok = verifier.verify(publicKey, sigBuf);
    expect(ok).toBe(true);
  });

  it("the same signature does NOT verify under RS256 (algorithm-strict)", () => {
    // Defends against accidental algorithm downgrade — Epic rejects RS256
    // for Backend Services so we must produce RS384 specifically.
    const jwt = buildClientAssertion(makeArgs());
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    const signingInput = `${header}.${payload}`;
    const sigBuf = Buffer.from(
      signature.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (signature.length % 4)) % 4),
      "base64",
    );
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    expect(verifier.verify(publicKey, sigBuf)).toBe(false);
  });
});
