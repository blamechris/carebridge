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
      "@carebridge/ai-prompts": path.resolve(
        __dirname,
        "../../packages/ai-prompts/src/index.ts",
      ),
      "@carebridge/phi-sanitizer": path.resolve(
        __dirname,
        "../../packages/phi-sanitizer/src/index.ts",
      ),
      "@carebridge/logger": path.resolve(
        __dirname,
        "../../packages/logger/src/index.ts",
      ),
      "@carebridge/db-schema": path.resolve(
        __dirname,
        "../../packages/db-schema/src/index.ts",
      ),
      "@carebridge/notifications": path.resolve(
        __dirname,
        "../../services/notifications/src/index.ts",
      ),
      "@carebridge/outbox": path.resolve(
        __dirname,
        "../../packages/outbox/src/index.ts",
      ),
      "@carebridge/redis-config": path.resolve(
        __dirname,
        "../../packages/redis-config/src/index.ts",
      ),
    },
  },
});
