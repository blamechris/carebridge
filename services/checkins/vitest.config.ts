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
      "@carebridge/validators": path.resolve(
        __dirname,
        "../../packages/validators/src/index.ts",
      ),
      "@carebridge/db-schema": path.resolve(
        __dirname,
        "../../packages/db-schema/src/index.ts",
      ),
      "@carebridge/redis-config": path.resolve(
        __dirname,
        "../../packages/redis-config/src/index.ts",
      ),
      "@carebridge/phi-sanitizer": path.resolve(
        __dirname,
        "../../packages/phi-sanitizer/src/index.ts",
      ),
    },
  },
});
