import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/phi-sanitizer",
  "services/ai-oversight",
  "services/auth",
  "services/fhir-gateway",
]);
