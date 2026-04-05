import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@carebridge/shared-types", "@carebridge/validators"],
};

export default nextConfig;
