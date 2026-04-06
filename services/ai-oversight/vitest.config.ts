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
      "@carebridge/medical-logic": path.resolve(
        __dirname,
        "../../packages/medical-logic/src/index.ts",
      ),
    },
  },
});
