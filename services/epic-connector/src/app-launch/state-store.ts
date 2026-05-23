/**
 * Short-lived launch-state storage for SMART App Launch (#392).
 *
 * The OAuth `state` parameter we mint on the /authorize step indexes a
 * server-side record holding:
 *   - the PKCE `code_verifier` we'll need on code exchange
 *   - the `iss` / token URL we discovered (so the callback doesn't have
 *     to re-fetch .well-known/smart-configuration)
 *   - the CareBridge user_id we associate the resulting tokens with
 *   - which redirect URL to bounce the user to after success
 *   - the launch-context token (`launch=…`) so we can correlate
 *
 * Backed by Redis with a short TTL — the OAuth state is single-use and
 * worthless after the user finishes the authorize round-trip. We don't
 * persist this to the main DB because:
 *   - one row per launch attempt would fill the table quickly
 *   - we don't want to GC abandoned authorize flows ourselves
 *
 * The interface is dependency-injected so tests can swap in an in-memory
 * store and avoid Redis.
 */
export interface LaunchState {
  /** PKCE verifier — never serialised to the client. */
  codeVerifier: string;
  /** Epic FHIR base URL (the `iss`). */
  iss: string;
  /** Resolved token endpoint URL. */
  tokenUrl: string;
  /** Authorize endpoint we redirected to (echoed for audit). */
  authorizeUrl: string;
  /** CareBridge user id this launch is for. */
  userId: string;
  /** Final redirect URL after success (e.g. /patients/<id>). */
  postLaunchRedirect: string;
  /** EHR-launch `launch` token, if this is an EHR launch. */
  launchToken?: string;
  /** Created-at wall-clock for debugging. */
  createdAt: string;
}

export interface LaunchStateStore {
  set(state: string, value: LaunchState, ttlSeconds: number): Promise<void>;
  get(state: string): Promise<LaunchState | null>;
  /** Remove (consume) — every state is single-use. */
  delete(state: string): Promise<void>;
}

/**
 * Pure in-memory implementation. Used in tests AND as a sane default
 * for single-process dev runs where bringing up Redis is overkill.
 * Production multi-pod deployments MUST swap for the Redis-backed
 * implementation below.
 */
export class InMemoryLaunchStateStore implements LaunchStateStore {
  private readonly store = new Map<
    string,
    { value: LaunchState; expiresAt: number }
  >();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async set(
    state: string,
    value: LaunchState,
    ttlSeconds: number,
  ): Promise<void> {
    this.store.set(state, {
      value,
      expiresAt: this.nowMs() + ttlSeconds * 1000,
    });
  }

  async get(state: string): Promise<LaunchState | null> {
    const entry = this.store.get(state);
    if (!entry) return null;
    if (entry.expiresAt < this.nowMs()) {
      this.store.delete(state);
      return null;
    }
    return entry.value;
  }

  async delete(state: string): Promise<void> {
    this.store.delete(state);
  }
}

/**
 * Redis-backed implementation. Pass an ioredis instance compatible
 * with the `set EX` / `get` / `del` commands. Kept narrow to avoid
 * pulling ioredis types into the package — host services already have
 * a connection.
 */
export interface RedisLike {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

const KEY_PREFIX = "epic:applaunch:state:";

export class RedisLaunchStateStore implements LaunchStateStore {
  constructor(private readonly redis: RedisLike) {}

  async set(
    state: string,
    value: LaunchState,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(
      KEY_PREFIX + state,
      JSON.stringify(value),
      "EX",
      ttlSeconds,
    );
  }

  async get(state: string): Promise<LaunchState | null> {
    const raw = await this.redis.get(KEY_PREFIX + state);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LaunchState;
    } catch {
      return null;
    }
  }

  async delete(state: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + state);
  }
}
