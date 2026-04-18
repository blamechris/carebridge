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
      "@carebridge/patient-records": path.resolve(
        __dirname,
        "../../services/patient-records/src/index.ts",
      ),
      "@carebridge/clinical-notes": path.resolve(
        __dirname,
        "../../services/clinical-notes/src/index.ts",
      ),
      // #896 matrix tests import the clinical-data router, which pulls in
      // `@carebridge/clinical-data`. The test swaps the repos via vi.mock,
      // but vite still needs a resolvable entry to satisfy the module graph.
      "@carebridge/clinical-data": path.resolve(
        __dirname,
        "../../services/clinical-data/src/index.ts",
      ),
      // Transitive deps of clinical-data / outbox — aliased to src so vite
      // can resolve the module graph. The tests mock them via `vi.mock` so
      // no real Redis / BullMQ code runs.
      "@carebridge/redis-config": path.resolve(
        __dirname,
        "../../packages/redis-config/src/index.ts",
      ),
      "@carebridge/outbox": path.resolve(
        __dirname,
        "../../packages/outbox/src/index.ts",
      ),
      "@carebridge/ai-oversight": path.resolve(
        __dirname,
        "../../services/ai-oversight/src/index.ts",
      ),
    },
  },
});
