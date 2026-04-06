import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../password.js";

describe("hashPassword", () => {
  it("returns a string in scrypt format", async () => {
    const hash = await hashPassword("password123");
    expect(hash).toMatch(/^scrypt:[a-f0-9]+:[a-f0-9]+$/);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const hash1 = await hashPassword("password123");
    const hash2 = await hashPassword("password123");
    expect(hash1).not.toBe(hash2);
  });
});

describe("verifyPassword", () => {
  it("returns true for correct password", async () => {
    const hash = await hashPassword("mySecret!");
    const result = await verifyPassword("mySecret!", hash);
    expect(result).toBe(true);
  });

  it("returns false for wrong password", async () => {
    const hash = await hashPassword("correctPassword");
    const result = await verifyPassword("wrongPassword", hash);
    expect(result).toBe(false);
  });

  it("rejects old 'hashed:' prefix format", async () => {
    const legacyHash = "hashed:password123";
    const result = await verifyPassword("password123", legacyHash);
    expect(result).toBe(false);
  });

  it("returns false for malformed hash string", async () => {
    const result = await verifyPassword("test", "garbage-not-a-hash");
    expect(result).toBe(false);
  });

  it("returns false for empty hash", async () => {
    const result = await verifyPassword("test", "");
    expect(result).toBe(false);
  });
});
