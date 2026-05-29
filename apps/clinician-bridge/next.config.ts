import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bridge is display-only. No service workers or background sync —
  // the device should not retain PHI past the tab session. See
  // docs/clinician-bridge-mvp.md § PHI / SaMD Posture.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Service-Worker-Allowed",
            value: "/__no_sw__",
          },
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, proxy-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
