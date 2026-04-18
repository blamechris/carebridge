import { describe, it, expect } from "vitest";

describe("patient-portal smoke", () => {
  it("vitest runs in the patient-portal workspace", () => {
    expect(1 + 1).toBe(2);
  });

  it("can import a workspace package", async () => {
    const mod = await import("@carebridge/portal-shared/auth");
    expect(typeof mod.AuthProvider).toBe("function");
    expect(typeof mod.useAuth).toBe("function");
  });
});
