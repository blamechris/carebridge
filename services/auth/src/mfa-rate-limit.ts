/**
 * In-memory rate limiter for MFA verification attempts.
 * Prevents brute-force attacks on TOTP codes and recovery codes.
 *
 * - Max 5 attempts per 15-minute window
 * - After 5 failed attempts, locked out for 15 minutes from the first attempt
 * - Successful verification clears the attempt history
 */

const MFA_MAX_ATTEMPTS = 5;
const MFA_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface AttemptRecord {
  count: number;
  firstAttempt: number;
}

const mfaAttempts = new Map<string, AttemptRecord>();

/**
 * Check whether an MFA attempt is allowed for the given key.
 * Returns { allowed: true } if within limits, or
 * { allowed: false, retryAfterMs } if the limit has been exceeded.
 */
export function checkMFARateLimit(key: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const record = mfaAttempts.get(key);
  if (!record) {
    return { allowed: true };
  }

  const elapsed = Date.now() - record.firstAttempt;

  // Window has expired -- reset
  if (elapsed >= MFA_WINDOW_MS) {
    mfaAttempts.delete(key);
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
export function recordMFAAttempt(key: string): void {
  const now = Date.now();
  const record = mfaAttempts.get(key);

  if (!record || now - record.firstAttempt >= MFA_WINDOW_MS) {
    mfaAttempts.set(key, { count: 1, firstAttempt: now });
    return;
  }

  record.count += 1;
}

/**
 * Clear MFA attempt history on successful verification.
 */
export function clearMFAAttempts(key: string): void {
  mfaAttempts.delete(key);
}

/**
 * Exposed for testing: reset all rate-limit state.
 */
export function _resetAllAttempts(): void {
  mfaAttempts.clear();
}

export { MFA_MAX_ATTEMPTS, MFA_WINDOW_MS };
