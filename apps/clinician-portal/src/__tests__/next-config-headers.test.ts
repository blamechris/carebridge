import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

/**
 * Issue #284: Patient UUIDs exposed in URLs (Referer leak risk).
 *
 * PHI pages such as /patients/[id] embed patient UUIDs in the URL path.
 * Without a strict Referrer-Policy, those UUIDs leak to any third-party
 * origin contacted from the page (analytics, embedded images, fonts, etc.)
 * via the outbound Referer header.
 *
 * The clinician portal exclusively serves PHI, so we set
 * "Referrer-Policy: no-referrer" globally via next.config headers().
 */
describe("clinician-portal next.config headers()", () => {
  it("defines a headers() function", () => {
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("sets Referrer-Policy: no-referrer on all routes", async () => {
    // headers() is defined above; guarded by previous test
    const headers = await nextConfig.headers!();

    // At least one entry must match every route
    const globalEntry = headers.find((h) => h.source === "/(.*)");
    expect(globalEntry).toBeDefined();

    const referrerHeader = globalEntry!.headers.find(
      (h) => h.key.toLowerCase() === "referrer-policy",
    );
    expect(referrerHeader).toBeDefined();
    expect(referrerHeader!.value).toBe("no-referrer");
  });
});
