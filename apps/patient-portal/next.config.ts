import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@carebridge/shared-types"],
};

export default nextConfig;
