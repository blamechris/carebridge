/**
 * SMART App Launch orchestrator (#392).
 *
 * Ties together the PKCE helpers, authorize URL builder, token exchange,
 * launch-state store, and connection repo so the Fastify route handlers
 * stay thin. Both EHR Launch (Epic bootstraps with `iss` + `launch`)
 * and Standalone Launch (we know the `iss` from settings) come through
 * the same `beginLaunch` → `completeLaunch` pair.
 */
import { randomBytes } from "node:crypto";
import { createLogger } from "@carebridge/logger";
import {
  fetchSmartConfiguration,
  type SmartConfiguration,
} from "../capability.js";
import { generatePkcePair } from "./pkce.js";
import {
  buildAuthorizeUrl,
  DEFAULT_APP_LAUNCH_SCOPES,
} from "./authorize.js";
import {
  exchangeAuthorizationCode,
  decodeIdTokenUnsafe,
  extractPractitionerId,
  type AppLaunchTokenResponse,
} from "./token-exchange.js";
import { upsertEpicConnection } from "./connection-repo.js";
import type { LaunchStateStore, LaunchState } from "./state-store.js";

const log = createLogger("epic-app-launch");

const STATE_TTL_SECONDS = 600; // 10 minutes — the user has to finish OAuth in that window

export interface BeginLaunchArgs {
  /** Epic FHIR base URL — from EHR launch `iss` param OR from settings for Standalone. */
  iss: string;
  /** EHR-launch `launch` token. Omit for Standalone. */
  launch?: string;
  /** CareBridge user id we will associate the resulting connection with. */
  userId: string;
  /** Callback URL we register with Epic. */
  redirectUri: string;
  /** CareBridge client id registered at open.epic.com. */
  clientId: string;
  /** Where to send the browser after a successful launch. */
  postLaunchRedirect: string;
  /** Override scopes; defaults to the full SMART set. */
  scopes?: readonly string[];
  /** Override the discovery fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override random bytes (test-only — predictable state values). */
  rng?: (size: number) => Buffer;
}

export interface BeginLaunchResult {
  /** Browser redirects here. */
  authorizeUrl: string;
  /** The OAuth state value — also the lookup key in the launch-state store. */
  state: string;
}

/**
 * Step 1: build the authorize URL, persist the launch state under the
 * generated `state`, and return both.
 */
export async function beginLaunch(
  args: BeginLaunchArgs,
  store: LaunchStateStore,
): Promise<BeginLaunchResult> {
  const smart = await fetchSmartConfiguration(args.iss, args.fetchImpl);
  if (!smart.authorization_endpoint) {
    throw new Error(
      `SMART configuration at ${args.iss} is missing authorization_endpoint — ` +
        "App Launch requires the OAuth authorize URL",
    );
  }
  const authorizationEndpoint = smart.authorization_endpoint;

  const pkce = generatePkcePair(args.rng);
  const state = generateOAuthState(args.rng);

  const scopes = (args.scopes ?? DEFAULT_APP_LAUNCH_SCOPES).slice();
  // Standalone launches must NOT request `launch` — Epic rejects the
  // authorize call if the scope is present without a launch token.
  if (!args.launch) {
    const idx = scopes.indexOf("launch");
    if (idx >= 0) scopes.splice(idx, 1);
  }

  const authorizeUrl = buildAuthorizeUrl({
    authorizeUrl: authorizationEndpoint,
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    scopes,
    state,
    aud: args.iss,
    codeChallenge: pkce.codeChallenge,
    launch: args.launch,
  });

  const launchState: LaunchState = {
    codeVerifier: pkce.codeVerifier,
    iss: args.iss,
    tokenUrl: smart.token_endpoint,
    authorizeUrl: authorizationEndpoint,
    userId: args.userId,
    postLaunchRedirect: args.postLaunchRedirect,
    launchToken: args.launch,
    createdAt: new Date().toISOString(),
  };
  await store.set(state, launchState, STATE_TTL_SECONDS);

  log.info("Epic App Launch initiated", {
    userId: args.userId,
    iss: args.iss,
    isEhrLaunch: Boolean(args.launch),
  });

  return { authorizeUrl, state };
}

export interface CompleteLaunchArgs {
  /** OAuth state from the callback query string. */
  state: string;
  /** Authorization code from the callback query string. */
  code: string;
  /** CareBridge client id (must match the begin step). */
  clientId: string;
  /** Callback URL (must match the begin step — Epic verifies). */
  redirectUri: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface CompleteLaunchResult {
  /** CareBridge connection row id we just upserted. */
  connectionId: string;
  /** Where the browser should land next. */
  postLaunchRedirect: string;
  /** FHIR Patient.id from launch context (EHR launch only). */
  patientFhirId: string | null;
  /** FHIR Encounter.id from launch context. */
  encounterFhirId: string | null;
  /** FHIR Practitioner.id derived from id_token.fhirUser, if present. */
  practitionerFhirId: string | null;
  /** Raw token response — useful for logging and debugging. */
  tokens: AppLaunchTokenResponse;
}

/**
 * Step 2: exchange the auth code for tokens, decode the id_token,
 * upsert the `epic_user_connections` row, and return where to send the
 * browser next. Throws on state mismatch / expired state / token-exchange
 * failure so the route handler can render a coherent error page.
 */
export async function completeLaunch(
  args: CompleteLaunchArgs,
  store: LaunchStateStore,
): Promise<CompleteLaunchResult> {
  const launchState = await store.get(args.state);
  if (!launchState) {
    throw new Error("Epic App Launch state expired or unknown");
  }
  // Single-use — drop the state before we even attempt the token
  // exchange so a leaked code can't be replayed.
  await store.delete(args.state);

  const tokens = await exchangeAuthorizationCode({
    tokenUrl: launchState.tokenUrl,
    code: args.code,
    redirectUri: args.redirectUri,
    clientId: args.clientId,
    codeVerifier: launchState.codeVerifier,
    fetchImpl: args.fetchImpl,
  });

  const decoded = tokens.id_token ? decodeIdTokenUnsafe(tokens.id_token) : null;
  const practitionerFhirId = extractPractitionerId(decoded?.fhirUser);

  const expiresAtMs = Date.now() + tokens.expires_in * 1000;

  const connectionId = await upsertEpicConnection({
    user_id: launchState.userId,
    epic_org_iss: launchState.iss,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: new Date(expiresAtMs).toISOString(),
    scopes: tokens.scope,
    id_token_subject: decoded?.sub ?? null,
    epic_practitioner_fhir_id: practitionerFhirId,
    epic_patient_fhir_id: tokens.patient ?? null,
    launch_encounter_fhir_id: tokens.encounter ?? null,
  });

  log.info("Epic App Launch completed", {
    connectionId,
    userId: launchState.userId,
    iss: launchState.iss,
    practitionerFhirId,
    hasPatientContext: Boolean(tokens.patient),
  });

  return {
    connectionId,
    postLaunchRedirect: launchState.postLaunchRedirect,
    patientFhirId: tokens.patient ?? null,
    encounterFhirId: tokens.encounter ?? null,
    practitionerFhirId,
    tokens,
  };
}

/**
 * 32 bytes → 43 base64url chars — same shape as the PKCE verifier so
 * Epic's permissive state validation accepts it without escaping
 * surprises in the URL.
 */
function generateOAuthState(rng: (size: number) => Buffer = randomBytes): string {
  return rng(32)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export type { SmartConfiguration };
