import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

/**
 * Issue #284: Patient UUIDs exposed in URLs (Referer leak risk).
 *
 * The patient portal displays a logged-in patient's own PHI. Any outbound
 * request from a PHI page (analytics, embedded images, fonts, etc.) would
 * otherwise leak the current URL — including patient identifiers — via the
 * Referer header.
 *
 * We set "Referrer-Policy: no-referrer" globally via next.config headers().
 */
describe("patient-portal next.config headers()", () => {
  it("defines a headers() function", () => {
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("sets Referrer-Policy: no-referrer on all routes", async () => {
    const headers = await nextConfig.headers!();

    // Look for any catch-all entry that sets Referrer-Policy: no-referrer.
    // Both the path-to-regexp catch-all syntax (`/:path*`) and the explicit
    // wildcard regex (`/(.*)`) are valid Next.js source patterns; assert on
    // the behavior, not the specific syntax.
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
