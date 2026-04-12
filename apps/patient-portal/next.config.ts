import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@carebridge/shared-types",
    "@carebridge/api-gateway",
    "@carebridge/auth",
    "@carebridge/patient-records",
    "@carebridge/clinical-data",
    "@carebridge/clinical-notes",
    "@carebridge/ai-oversight",
    "@carebridge/db-schema",
    "@carebridge/validators",
  ],
  // Issue #284: PHI pages embed patient identifiers in the URL path.
  // Without a strict Referrer-Policy, those identifiers leak to any
  // third-party origin contacted from the page via the outbound Referer
  // header. The patient portal exclusively serves the logged-in patient's
  // own PHI, so we apply "no-referrer" globally.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
