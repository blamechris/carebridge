/**
 * TOTP replay-attack prevention via Redis.
 *
 * After a TOTP code is successfully verified we store it in Redis with a
 * short TTL (90 seconds — one full TOTP period plus clock-drift tolerance).
 * Before accepting any code we check the store; if the code has already been
 * used within its validity window, verification is rejected.
 *
 * Key format: totp:used:{userId}:{code}
 */

import Redis from "ioredis";
import { getRedisConnection } from "@carebridge/redis-config";

const USED_CODE_TTL_SECONDS = 90;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const opts = getRedisConnection();
    redis = new Redis(opts);
  }
  return redis;
}

function usedCodeKey(userId: string, code: string): string {
  return `totp:used:${userId}:${code}`;
}

/**
 * Returns `true` if the code has already been used (i.e. it is a replay).
 */
export async function isTOTPCodeUsed(
  userId: string,
  code: string,
): Promise<boolean> {
  const key = usedCodeKey(userId, code);
  const result = await getRedis().exists(key);
  return result === 1;
}

/**
 * Mark a TOTP code as used. Must be called immediately after successful
 * verification so that any subsequent attempt with the same code is rejected.
 */
export async function markTOTPCodeUsed(
  userId: string,
  code: string,
): Promise<void> {
  const key = usedCodeKey(userId, code);
  await getRedis().set(key, "1", "EX", USED_CODE_TTL_SECONDS);
}
