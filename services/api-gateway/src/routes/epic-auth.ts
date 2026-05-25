/**
 * SMART on FHIR App Launch routes (#392).
 *
 * Two endpoints:
 *  GET /auth/epic/authorize  — kicks off the OAuth flow. Two ways in:
 *      EHR Launch (Epic-initiated):
 *        Epic redirects the user's browser to
 *        `<our-host>/auth/epic/authorize?iss=<epic-base>&launch=<token>`
 *      Standalone Launch (us-initiated):
 *        Clinician clicks "Connect to Epic" → we redirect their browser
 *        to `/auth/epic/authorize?iss=<epic-base>` (no launch token).
 *
 *  GET /auth/epic/callback   — handles the redirect back from Epic.
 *      Verifies state, exchanges the code for tokens, persists the
 *      connection row, and bounces the browser to the post-launch
 *      destination.
 *
 * Both endpoints require an authenticated CareBridge session. For EHR
 * Launch, the clinician must already be signed into CareBridge in the
 * same browser session that Epic's MyChart shell is hosted in
 * (typical Epic deployment puts the browser in an iframe that shares
 * cookies). Sessions are out of scope here — `request.user` is set by
 * the auth middleware before our handler runs.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import {
  beginLaunch,
  completeLaunch,
  RedisLaunchStateStore,
  InMemoryLaunchStateStore,
  type LaunchStateStore,
  type RedisLike,
} from "@carebridge/epic-connector";
import { createLogger } from "@carebridge/logger";

const log = createLogger("epic-auth-routes");

/**
 * Sentinel origin used to parse a candidate redirect as a URL relative to
 * a known-bad base. If the resulting `URL.origin` differs, the input
 * declared its own origin (i.e. it's absolute or protocol-relative) and
 * we must reject — otherwise we'd hand attackers an open-redirect via
 * `?redirect=https://evil.example` etc.
 */
const REDIRECT_BASE = "http://placeholder.invalid";

/**
 * Validate that `redirect` is a same-origin path we can safely hand to
 * `reply.redirect()` on the callback. Returns the normalised redirect
 * string on success, or `null` to signal "reject as 400".
 *
 * Accepts:
 *   - missing / empty → `/`
 *   - any string that starts with `/` and parses as a path relative to
 *     the placeholder origin (i.e. URL parsing does not promote it to
 *     a different origin)
 *
 * Rejects:
 *   - absolute URLs (`https://attacker.example/…`)
 *   - protocol-relative (`//attacker.example`)
 *   - Windows-path tricks (`\\attacker.example`)
 *   - any `scheme:` form (`javascript:`, `data:`, etc.) — caught by the
 *     same-origin check after URL parsing.
 *
 * Path-traversal like `/../../etc/passwd` is NOT rejected here — it's
 * still a same-origin path, so it can't take the user off our origin.
 * Defending against traversal is the receiving handler's job.
 */
export function validateRedirect(redirect: string | undefined): string | null {
  if (redirect === undefined || redirect === "") {
    return "/";
  }

  // Must start with a single forward slash. Reject `//…` (protocol-
  // relative) and `\\…` (Windows-style) up-front so a malformed URL
  // parser quirk can't slip them through.
  if (!redirect.startsWith("/")) return null;
  if (redirect.startsWith("//")) return null;
  if (redirect.startsWith("/\\")) return null;

  let parsed: URL;
  try {
    parsed = new URL(redirect, REDIRECT_BASE);
  } catch {
    return null;
  }

  // If URL parsing produced a different origin, the input declared one
  // of its own — that's the open-redirect vector we're closing.
  if (parsed.origin !== REDIRECT_BASE) return null;
  if (!parsed.pathname.startsWith("/")) return null;

  return redirect;
}

interface EpicAuthRouteOptions {
  redis?: Redis;
  /**
   * Override the launch-state store for tests. When omitted and `redis`
   * is provided, uses RedisLaunchStateStore; otherwise an in-memory
   * fallback (single-process dev only).
   */
  store?: LaunchStateStore;
}

interface AuthorizeQuery {
  iss?: string;
  launch?: string;
  redirect?: string;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export function registerEpicAuthRoutes(
  server: FastifyInstance,
  opts: EpicAuthRouteOptions = {},
): void {
  const clientId = process.env.EPIC_CLIENT_ID;
  const redirectUri = process.env.EPIC_APP_LAUNCH_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    log.info(
      "Epic App Launch routes not registered — EPIC_CLIENT_ID or EPIC_APP_LAUNCH_REDIRECT_URI not set",
    );
    return;
  }

  let store: LaunchStateStore;
  if (opts.store) {
    store = opts.store;
  } else if (opts.redis) {
    const redis = opts.redis;
    const redisAdapter: RedisLike = {
      set: (k, v, mode, ttl) =>
        redis.set(k, v, mode, ttl) as Promise<unknown>,
      get: (k) => redis.get(k),
      del: (k) => redis.del(k),
    };
    store = new RedisLaunchStateStore(redisAdapter);
  } else {
    store = new InMemoryLaunchStateStore();
  }

  server.get<{ Querystring: AuthorizeQuery }>(
    "/auth/epic/authorize",
    async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: "authentication_required" });
      }
      const iss = request.query.iss;
      if (!iss) {
        return reply.code(400).send({
          error: "missing_iss",
          message: "Provide ?iss=<Epic FHIR base URL>",
        });
      }

      // #1185 — Validate `redirect` BEFORE we persist anything to launch
      // state. The callback later does `reply.redirect(postLaunchRedirect)`
      // verbatim, so an unchecked value here is a classic open-redirect
      // surface. The validator accepts only same-origin paths.
      const safeRedirect = validateRedirect(request.query.redirect);
      if (safeRedirect === null) {
        return reply.code(400).send({
          error: "invalid_redirect",
          message:
            "?redirect must be a same-origin path starting with '/'. " +
            "Absolute URLs, protocol-relative '//', and 'scheme:' forms " +
            "are rejected.",
        });
      }

      try {
        const { authorizeUrl } = await beginLaunch(
          {
            iss,
            launch: request.query.launch,
            userId: request.user.id,
            redirectUri,
            clientId,
            postLaunchRedirect: safeRedirect,
          },
          store,
        );
        return reply.redirect(authorizeUrl);
      } catch (err) {
        log.error("Epic App Launch begin failed", {
          userId: request.user.id,
          iss,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(502).send({
          error: "epic_discovery_failed",
          message: err instanceof Error ? err.message : "unknown error",
        });
      }
    },
  );

  server.get<{ Querystring: CallbackQuery }>(
    "/auth/epic/callback",
    async (request: FastifyRequest<{ Querystring: CallbackQuery }>, reply: FastifyReply) => {
      // Epic returns ?error=… on user-denial / consent failure.
      if (request.query.error) {
        return reply.code(400).send({
          error: request.query.error,
          message: request.query.error_description ?? "Epic returned an OAuth error",
        });
      }

      const state = request.query.state;
      const code = request.query.code;
      if (!state || !code) {
        return reply.code(400).send({
          error: "missing_callback_params",
          message: "Expected ?state and ?code in callback URL",
        });
      }

      try {
        const result = await completeLaunch(
          { state, code, clientId, redirectUri },
          store,
        );
        // EHR-launch context lives in the redirect URL as query params so
        // the SPA can pick them up without another round-trip.
        const target = new URL(result.postLaunchRedirect, "http://_dummy");
        if (result.patientFhirId) {
          target.searchParams.set("epic_patient", result.patientFhirId);
        }
        if (result.encounterFhirId) {
          target.searchParams.set("epic_encounter", result.encounterFhirId);
        }
        const finalUrl =
          target.origin === "http://_dummy"
            ? target.pathname + target.search
            : target.toString();
        return reply.redirect(finalUrl);
      } catch (err) {
        log.error("Epic App Launch callback failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(400).send({
          error: "epic_callback_failed",
          message: err instanceof Error ? err.message : "unknown error",
        });
      }
    },
  );
}
