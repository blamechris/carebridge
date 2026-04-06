import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
  },
  resolve: {
    alias: {
      "@carebridge/db-schema": path.resolve(
        __dirname,
        "../../packages/db-schema/src/index.ts",
      ),
      "@carebridge/shared-types": path.resolve(
        __dirname,
        "../../packages/shared-types/src/index.ts",
      ),
      "@carebridge/validators": path.resolve(
        __dirname,
        "../../packages/validators/src/index.ts",
      ),
      "@carebridge/auth": path.resolve(
        __dirname,
        "../../services/auth/src/index.ts",
      ),
    },
  },
});
