import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // Use the automatic JSX runtime so modules that don't `import React`
  // (e.g. Next.js app-router files like `app/layout.tsx`) still transform
  // cleanly under vitest. Matches the patient-portal config.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    globals: false,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
