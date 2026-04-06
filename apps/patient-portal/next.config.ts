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
};

export default nextConfig;
