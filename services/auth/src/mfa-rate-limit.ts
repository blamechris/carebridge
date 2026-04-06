/**
 * Redis-backed rate limiter for MFA verification attempts.
 * Prevents brute-force attacks on TOTP codes and recovery codes.
 *
 * - Max 5 attempts per 15-minute window
 * - After 5 failed attempts, locked out for 15 minutes from the first attempt
 * - Successful verification clears the attempt history
 *
 * State is stored in Redis so it survives process restarts and is
 * consistent across multiple service replicas.
 */

import Redis from "ioredis";
import { getRedisConnection } from "@carebridge/redis-config";

const MFA_MAX_ATTEMPTS = 5;
const MFA_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MFA_WINDOW_SECONDS = Math.ceil(MFA_WINDOW_MS / 1000);

const KEY_PREFIX = "mfa:rate:";

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const opts = getRedisConnection();
    _redis = new Redis({
      host: opts.host,
      port: opts.port,
      password: opts.password,
      tls: opts.tls,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }
  return _redis;
}

/**
 * Check whether an MFA attempt is allowed for the given key.
 * Returns { allowed: true } if within limits, or
 * { allowed: false, retryAfterMs } if the limit has been exceeded.
 */
export async function checkMFARateLimit(key: string): Promise<{
  allowed: boolean;
  retryAfterMs?: number;
}> {
  const redis = getRedis();
  const redisKey = `${KEY_PREFIX}${key}`;

  const data = await redis.get(redisKey);
  if (!data) {
    return { allowed: true };
  }

  const record: { count: number; firstAttempt: number } = JSON.parse(data);
  const elapsed = Date.now() - record.firstAttempt;

  // Window has expired -- Redis TTL should handle cleanup, but be safe
  if (elapsed >= MFA_WINDOW_MS) {
    await redis.del(redisKey);
    return { allowed: true };
  }

  // Under the limit
  if (record.count < MFA_MAX_ATTEMPTS) {
    return { allowed: true };
  }

  // Locked out
  const retryAfterMs = MFA_WINDOW_MS - elapsed;
  return { allowed: false, retryAfterMs };
}

/**
 * Record a failed MFA attempt for the given key.
 */
export async function recordMFAAttempt(key: string): Promise<void> {
  const redis = getRedis();
  const redisKey = `${KEY_PREFIX}${key}`;
  const now = Date.now();

  const data = await redis.get(redisKey);

  if (!data) {
    const record = { count: 1, firstAttempt: now };
    await redis.set(redisKey, JSON.stringify(record), "EX", MFA_WINDOW_SECONDS);
    return;
  }

  const record: { count: number; firstAttempt: number } = JSON.parse(data);
  const elapsed = now - record.firstAttempt;

  if (elapsed >= MFA_WINDOW_MS) {
    // Window expired, start fresh
    const fresh = { count: 1, firstAttempt: now };
    await redis.set(redisKey, JSON.stringify(fresh), "EX", MFA_WINDOW_SECONDS);
    return;
  }

  // Increment count, preserve original TTL
  record.count += 1;
  const remainingSeconds = Math.ceil((MFA_WINDOW_MS - elapsed) / 1000);
  await redis.set(
    redisKey,
    JSON.stringify(record),
    "EX",
    remainingSeconds,
  );
}

/**
 * Clear MFA attempt history on successful verification.
 */
export async function clearMFAAttempts(key: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${KEY_PREFIX}${key}`);
}

/**
 * Exposed for testing: reset all rate-limit state.
 */
export async function _resetAllAttempts(): Promise<void> {
  const redis = getRedis();
  const keys = await redis.keys(`${KEY_PREFIX}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export { MFA_MAX_ATTEMPTS, MFA_WINDOW_MS };
