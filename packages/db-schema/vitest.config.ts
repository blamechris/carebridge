import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The legacy encryption.test.ts / hmac.test.ts / mfa-secret-encryption.test.ts
    // files in this directory use the node:test runner (imports from "node:test")
    // and are not currently wired into CI. Include only the vitest-native tests
    // here to avoid picking them up and failing on incompatible imports.
    include: ["src/__tests__/encrypt-clinical-narratives.test.ts"],
  },
});
