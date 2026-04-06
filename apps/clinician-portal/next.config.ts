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
};

export default nextConfig;
