import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
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
