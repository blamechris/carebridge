/**
 * Epic connector configuration (#389).
 *
 * Resolves Epic credentials from environment, validates required fields,
 * and loads the RS384 private key used to sign JWT client assertions for
 * the SMART Backend Services flow.
 *
 * Env vars:
 *   EPIC_CLIENT_ID            — Non-Production / Production Client ID issued
 *                               by open.epic.com after app registration.
 *   EPIC_TOKEN_URL            — OAuth2 token endpoint (resolved from the
 *                               sandbox default when absent).
 *   EPIC_FHIR_BASE_URL        — FHIR R4 base URL for read operations.
 *   EPIC_PRIVATE_KEY_PATH     — Filesystem path to the RS384 private-key
 *                               PEM. Mutually exclusive with PEM env.
 *   EPIC_PRIVATE_KEY_PEM      — Inline PEM string. Takes precedence over
 *                               PATH only when PATH is absent — explicit
 *                               PATH preferred for ease of rotation.
 *   EPIC_JWT_KID              — Key id matching the JWK uploaded at
 *                               open.epic.com. Required so Epic can
 *                               select the right public key when the
 *                               registered JWKS has more than one entry.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const SANDBOX_TOKEN_URL =
  "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
const SANDBOX_FHIR_BASE_URL =
  "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/";

const configSchema = z.object({
  clientId: z.string().min(1, "EPIC_CLIENT_ID is required"),
  tokenUrl: z.string().url(),
  fhirBaseUrl: z.string().url(),
  privateKeyPem: z
    .string()
    .min(1)
    .refine(
      (pem) =>
        pem.includes("BEGIN RSA PRIVATE KEY") ||
        pem.includes("BEGIN PRIVATE KEY"),
      "private key must be a PEM-encoded RSA key",
    ),
  jwtKid: z.string().min(1, "EPIC_JWT_KID is required"),
});

export type EpicConfig = z.infer<typeof configSchema>;

function readPrivateKey(env: NodeJS.ProcessEnv): string {
  const inlinePem = env.EPIC_PRIVATE_KEY_PEM;
  const path = env.EPIC_PRIVATE_KEY_PATH;

  if (path) {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(
        `Failed to read EPIC_PRIVATE_KEY_PATH "${path}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (inlinePem) return inlinePem;
  throw new Error(
    "Either EPIC_PRIVATE_KEY_PATH or EPIC_PRIVATE_KEY_PEM must be set",
  );
}

/**
 * Resolve the Epic connector configuration from process env. Throws on
 * missing required values or a malformed private key — fail loudly at
 * boot rather than at first token request.
 */
export function loadEpicConfig(env: NodeJS.ProcessEnv = process.env): EpicConfig {
  const parsed = configSchema.parse({
    clientId: env.EPIC_CLIENT_ID,
    tokenUrl: env.EPIC_TOKEN_URL ?? SANDBOX_TOKEN_URL,
    fhirBaseUrl: env.EPIC_FHIR_BASE_URL ?? SANDBOX_FHIR_BASE_URL,
    privateKeyPem: readPrivateKey(env),
    jwtKid: env.EPIC_JWT_KID,
  });
  return parsed;
}

export const EPIC_SANDBOX_TOKEN_URL = SANDBOX_TOKEN_URL;
export const EPIC_SANDBOX_FHIR_BASE_URL = SANDBOX_FHIR_BASE_URL;
