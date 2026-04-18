import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/phi-sanitizer",
  "packages/test-utils",
  "services/ai-oversight",
  "services/auth",
  "services/clinical-notes",
  "services/fhir-gateway",
]);
