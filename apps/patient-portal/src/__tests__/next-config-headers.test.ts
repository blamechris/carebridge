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

    const globalEntry = headers.find((h) => h.source === "/(.*)");
    expect(globalEntry).toBeDefined();

    const referrerHeader = globalEntry!.headers.find(
      (h) => h.key.toLowerCase() === "referrer-policy",
    );
    expect(referrerHeader).toBeDefined();
    expect(referrerHeader!.value).toBe("no-referrer");
  });
});
