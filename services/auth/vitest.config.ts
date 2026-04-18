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
      "@carebridge/test-utils": path.resolve(
        __dirname,
        "../../packages/test-utils/src/index.ts",
      ),
    },
  },
});
