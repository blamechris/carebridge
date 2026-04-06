import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { signJWT, verifyJWT, JWTError, JWTExpiredError } from "../jwt.js";
import type { JWTPayload } from "../jwt.js";

// signJWT / verifyJWT require JWT_SECRET to be set
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

beforeAll(() => {
  process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests";
});

afterAll(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  } else {
    delete process.env.JWT_SECRET;
  }
});

function makePayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-123",
    sid: "session-456",
    iat: now,
    exp: now + 3600, // 1 hour from now
    ...overrides,
  };
}

describe("signJWT", () => {
  it("produces a valid compact JWT string", async () => {
    const token = await signJWT(makePayload());

    expect(typeof token).toBe("string");
    // Compact JWTs have three base64url-encoded segments separated by dots
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });
});

describe("verifyJWT", () => {
  it("returns correct payload after sign → verify round-trip", async () => {
    const payload = makePayload();
    const token = await signJWT(payload);

    const decoded = await verifyJWT(token);

    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.sid).toBe(payload.sid);
    expect(decoded.iat).toBe(payload.iat);
    expect(decoded.exp).toBe(payload.exp);
  });

  it("throws JWTExpiredError for expired tokens", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const payload = makePayload({ iat: past - 3600, exp: past });
    const token = await signJWT(payload);

    await expect(verifyJWT(token)).rejects.toThrow(JWTExpiredError);
  });

  it("throws JWTError for tampered tokens", async () => {
    const token = await signJWT(makePayload());

    // Corrupt the signature portion (last segment)
    const parts = token.split(".");
    parts[2] = parts[2]!.slice(0, -4) + "XXXX";
    const tampered = parts.join(".");

    await expect(verifyJWT(tampered)).rejects.toThrow(JWTError);
  });

  it("throws JWTError for completely invalid token strings", async () => {
    await expect(verifyJWT("not-a-jwt")).rejects.toThrow(JWTError);
  });

  it("preserves sub and sid claims through round-trip", async () => {
    const payload = makePayload({ sub: "user-abc-def", sid: "sess-xyz-789" });
    const token = await signJWT(payload);
    const decoded = await verifyJWT(token);

    expect(decoded.sub).toBe("user-abc-def");
    expect(decoded.sid).toBe("sess-xyz-789");
  });
});
