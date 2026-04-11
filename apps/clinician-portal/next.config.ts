import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@carebridge/shared-types",
    "@carebridge/validators",
    "@carebridge/api-gateway",
    "@carebridge/auth",
    "@carebridge/patient-records",
    "@carebridge/clinical-data",
    "@carebridge/clinical-notes",
    "@carebridge/ai-oversight",
    "@carebridge/db-schema",
  ],
  // Issue #284: PHI pages embed patient UUIDs in the URL path
  // (e.g. /patients/[id]). Without a strict Referrer-Policy, those
  // identifiers leak to any third-party origin contacted from the page
  // via the outbound Referer header. The clinician portal exclusively
  // serves PHI, so we apply "no-referrer" globally.
  async headers() {
    return [
      {
        source: "/(.*)",
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
