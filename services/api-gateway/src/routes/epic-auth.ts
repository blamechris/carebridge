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

      try {
        const { authorizeUrl } = await beginLaunch(
          {
            iss,
            launch: request.query.launch,
            userId: request.user.id,
            redirectUri,
            clientId,
            postLaunchRedirect: request.query.redirect ?? "/",
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
