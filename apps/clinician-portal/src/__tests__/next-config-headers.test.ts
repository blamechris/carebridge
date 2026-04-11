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

    // Look for any catch-all entry that sets Referrer-Policy: no-referrer.
    // Both `/:path*` (path-to-regexp catch-all) and `/(.*)` (raw regex)
    // are valid Next.js source patterns; assert on the behavior, not the
    // specific syntax.
    const globalEntry = headers.find((entry) => {
      const isGlobalRoute =
        entry.source === "/:path*" || entry.source === "/(.*)";
      const referrerHeader = entry.headers.find(
        (h) => h.key.toLowerCase() === "referrer-policy",
      );
      return isGlobalRoute && referrerHeader?.value === "no-referrer";
    });

    expect(globalEntry).toBeDefined();
  });
});
