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
 *                               PEM. Takes precedence when set.
 *   EPIC_PRIVATE_KEY_PEM      — Inline PEM string. Used only when
 *                               EPIC_PRIVATE_KEY_PATH is unset. Setting
 *                               both is allowed but PATH wins — explicit
 *                               PATH is preferred for ease of rotation.
 *   EPIC_JWT_KID              — Key id matching the JWK uploaded at
 *                               open.epic.com. Required so Epic can
 *                               select the right public key when the
 *                               registered JWKS has more than one entry.
 */
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { z } from "zod";

const SANDBOX_TOKEN_URL =
  "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
const SANDBOX_FHIR_BASE_URL =
  "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/";

/**
 * Fully parse + validate the private key PEM at config load (#1089).
 *
 * Previously this checked only for the presence of PEM-header
 * substrings, which let non-RSA PKCS#8 keys and passphrase-encrypted
 * PEMs through to surface as confusing signing errors at the first
 * token request. We now feed the PEM to `crypto.createPrivateKey` and
 * assert the resulting KeyObject is RSA so we fail loudly at boot.
 *
 * The function throws a plain `Error` with a clear, no-PHI message so
 * the Zod `refine` wrapper around it can pass the message straight
 * through to the operator.
 */
function assertRsaPrivateKey(pem: string): void {
  // Encrypted PKCS#8 PEMs are wrapped in `-----BEGIN ENCRYPTED PRIVATE
  // KEY-----`. Detect this header upfront so we can surface a clear,
  // stable message — OpenSSL's parse-failure text for missing
  // passphrases varies by Node/OpenSSL version (e.g. "bad decrypt",
  // "interrupted or cancelled") and isn't safe to match on.
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pem)) {
    throw new Error(
      "private key must NOT be encrypted (passphrase-protected PEM is not supported; provide a decrypted RSA key)",
    );
  }
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`private key is not a valid PEM: ${message}`);
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      `private key must be RSA (got ${key.asymmetricKeyType ?? "unknown"}); Epic SMART Backend Services requires RS384`,
    );
  }
}

const configSchema = z.object({
  clientId: z.string().min(1, "EPIC_CLIENT_ID is required"),
  tokenUrl: z.string().url(),
  fhirBaseUrl: z.string().url(),
  privateKeyPem: z
    .string()
    .min(1)
    .superRefine((pem, ctx) => {
      try {
        assertRsaPrivateKey(pem);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
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
