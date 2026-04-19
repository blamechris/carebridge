import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@carebridge/shared-types": path.resolve(
        __dirname,
        "../../packages/shared-types/src/index.ts",
      ),
      "@carebridge/db-schema": path.resolve(
        __dirname,
        "../../packages/db-schema/src/index.ts",
      ),
      "@carebridge/logger": path.resolve(
        __dirname,
        "../../packages/logger/src/index.ts",
      ),
      "@carebridge/redis-config": path.resolve(
        __dirname,
        "../../packages/redis-config/src/index.ts",
      ),
      "@carebridge/notifications": path.resolve(
        __dirname,
        "../notifications/src/index.ts",
      ),
      "@carebridge/test-utils": path.resolve(
        __dirname,
        "../../packages/test-utils/src/index.ts",
      ),
    },
  },
});
