import { TRPCError, initTRPC } from "@trpc/server";
import { z } from "zod";
import type { User } from "@carebridge/shared-types";
import {
  loginSchema,
  createUserSchema,
  mfaVerifySchema,
  mfaDisableSchema,
  mfaCompleteLoginSchema,
} from "@carebridge/validators";
import { getDb, users, sessions } from "@carebridge/db-schema";
import { eq, and, gt, asc, inArray } from "drizzle-orm";
import crypto from "node:crypto";
import {
  generateSecret,
  generateTOTP,
  verifyTOTP,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  buildOTPAuthURI,
} from "./totp.js";
import {
  checkMFARateLimit,
  recordMFAAttempt,
  clearMFAAttempts,
} from "./mfa-rate-limit.js";
import {
  hashPassword,
  verifyPassword,
} from "./password.js";

// ---------- tRPC setup (mirrors api-gateway's context shape) ----------

export interface Context {
  db: ReturnType<typeof getDb>;
  user: User | null;
  sessionId: string | null;
  requestId: string;
}

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource.",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const publicProcedure = t.procedure;
const protectedProcedure = t.procedure.use(isAuthenticated);

// ---------- Helpers ----------

const REFRESH_TOKEN_HMAC_KEY = process.env.REFRESH_TOKEN_HMAC_KEY ?? process.env.SESSION_SECRET ?? "carebridge-dev-hmac-key";

/**
 * Hash a refresh token with HMAC-SHA256 before storing it in the database.
 * The raw token is returned to the client; only the hash is persisted.
 */
function hashToken(token: string): string {
  return crypto.createHmac("sha256", REFRESH_TOKEN_HMAC_KEY).update(token).digest("hex");
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MFA_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes for MFA completion
const MAX_CONCURRENT_SESSIONS = 5; // max active sessions per user

/**
 * In-memory store for pending MFA sessions.
 * Maps mfaSessionId -> { userId, expiresAt }
 */
const pendingMFASessions = new Map<
  string,
  { userId: string; expiresAt: number }
>();

/**
 * Verify a password against a stored hash, with a backward-compat fallback
 * for legacy dev seeds that used the `hashed:<plaintext>` format.
 * In production that format is unconditionally rejected.
 */
async function checkPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("hashed:")) {
    // Legacy dev-seed format: never accept in production.
    if (process.env.NODE_ENV === "production") return false;
    return storedHash === `hashed:${password}`;
  }
  return verifyPassword(password, storedHash);
}

/**
 * Enforce the per-user concurrent session limit.
 *
 * Fetches all non-expired sessions for `userId` ordered oldest-first.
 * If the count is at or above MAX_CONCURRENT_SESSIONS, the oldest sessions
 * are deleted so that the count drops to MAX_CONCURRENT_SESSIONS - 1,
 * leaving room for the new session about to be inserted by the caller.
 */
async function enforceSessionLimit(db: ReturnType<typeof getDb>, userId: string): Promise<void> {
  const now = new Date().toISOString();

  const activeSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.user_id, userId),
        gt(sessions.expires_at, now),
      ),
    )
    .orderBy(asc(sessions.created_at));

  const overflow = activeSessions.length - (MAX_CONCURRENT_SESSIONS - 1);
  if (overflow <= 0) return;

  const toEvict = activeSessions.slice(0, overflow).map((s) => s.id);
  await db.delete(sessions).where(inArray(sessions.id, toEvict));
}

function buildUserResponse(row: {
  id: string;
  email: string;
  name: string;
  role: string;
  specialty: string | null;
  department: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as User["role"],
    specialty: row.specialty ?? undefined,
    department: row.department ?? undefined,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------- Router ----------

export const authRouter = t.router({
  /**
   * Log in with email + password.
   * If MFA is enabled, returns { requiresMFA, mfaSessionId } instead of a full session.
   */
  login: publicProcedure.input(loginSchema).mutation(async ({ input }) => {
    const db = getDb();

    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    if (userRows.length === 0) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid email or password.",
      });
    }

    const row = userRows[0]!;

    if (!(await checkPassword(input.password, row.password_hash))) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid email or password.",
      });
    }

    if (!row.is_active) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Account is deactivated.",
      });
    }

    // Check if MFA is enabled
    if (row.mfa_enabled === true) {
      const mfaSessionId = crypto.randomUUID();
      const expiresAt = Date.now() + MFA_SESSION_TTL_MS;
      pendingMFASessions.set(mfaSessionId, {
        userId: row.id,
        expiresAt,
      });

      // Auto-cleanup if the user abandons the MFA flow
      setTimeout(() => {
        pendingMFASessions.delete(mfaSessionId);
      }, MFA_SESSION_TTL_MS);

      return {
        requiresMFA: true as const,
        mfaSessionId,
      };
    }

    // No MFA -- issue session directly
    await enforceSessionLimit(db, row.id);

    const sessionId = crypto.randomUUID();
    const refreshToken = crypto.randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await db.insert(sessions).values({
      id: sessionId,
      user_id: row.id,
      expires_at: expiresAt,
      created_at: now,
      last_active_at: now,
      refresh_token: hashToken(refreshToken),
    });

    return {
      user: buildUserResponse(row),
      session: { id: sessionId, user_id: row.id, expires_at: expiresAt, refresh_token: refreshToken },
    };
  }),

  /**
   * Complete login for users with MFA enabled.
   * Accepts a TOTP code or a recovery code.
   */
  mfaCompleteLogin: publicProcedure
    .input(mfaCompleteLoginSchema)
    .mutation(async ({ input }) => {
      // Rate-limit check keyed on mfaSessionId
      const rateLimit = checkMFARateLimit(input.mfaSessionId);
      if (!rateLimit.allowed) {
        const retryMinutes = Math.ceil((rateLimit.retryAfterMs ?? 0) / 60_000);
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Too many MFA attempts. Try again in ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`,
        });
      }

      const db = getDb();
      const pending = pendingMFASessions.get(input.mfaSessionId);

      if (!pending || pending.expiresAt < Date.now()) {
        pendingMFASessions.delete(input.mfaSessionId);
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "MFA session expired or invalid. Please log in again.",
        });
      }

      // Look up the user
      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, pending.userId))
        .limit(1);

      if (userRows.length === 0) {
        pendingMFASessions.delete(input.mfaSessionId);
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not found.",
        });
      }

      const row = userRows[0]!;
      const code = input.code.trim();
      let verified = false;

      // Try TOTP verification first (6-digit code)
      if (/^\d{6}$/.test(code) && row.mfa_secret) {
        verified = verifyTOTP(row.mfa_secret, code);
      }

      // Try recovery code if TOTP didn't match (format: XXXXX-XXXXX)
      if (!verified && row.recovery_codes) {
        const hashedCodes: string[] = JSON.parse(row.recovery_codes);
        const matchIdx = verifyRecoveryCode(code, hashedCodes);

        if (matchIdx >= 0) {
          verified = true;
          // Remove used recovery code
          hashedCodes.splice(matchIdx, 1);
          await db
            .update(users)
            .set({
              recovery_codes: JSON.stringify(hashedCodes),
              updated_at: new Date().toISOString(),
            })
            .where(eq(users.id, row.id));
        }
      }

      if (!verified) {
        recordMFAAttempt(input.mfaSessionId);
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid MFA code.",
        });
      }

      // Successful verification -- clear rate-limit history and pending session
      clearMFAAttempts(input.mfaSessionId);
      pendingMFASessions.delete(input.mfaSessionId);

      // Create real session (evict oldest if at concurrent limit first)
      await enforceSessionLimit(db, row.id);

      const sessionId = crypto.randomUUID();
      const refreshToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

      const now = new Date().toISOString();
      await db.insert(sessions).values({
        id: sessionId,
        user_id: row.id,
        expires_at: expiresAt,
        created_at: now,
        last_active_at: now,
        refresh_token: hashToken(refreshToken),
      });

      return {
        user: buildUserResponse(row),
        session: { id: sessionId, user_id: row.id, expires_at: expiresAt, refresh_token: refreshToken },
      };
    }),

  /**
   * Log out -- deletes only the current session identified by the caller's token.
   */
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    const db = getDb();

    if (ctx.sessionId) {
      // Delete only the current session, preserving all other active sessions.
      await db.delete(sessions).where(
        and(eq(sessions.id, ctx.sessionId), eq(sessions.user_id, ctx.user.id)),
      );
    }

    return { success: true };
  }),

  /**
   * Exchange a refresh token for a new session + refresh token pair.
   *
   * The old session is atomically deleted and a fresh one is created,
   * so each refresh token is single-use. Refresh tokens are valid for
   * up to 30 days from session creation regardless of the session TTL.
   */
  refreshSession: publicProcedure
    .input(z.object({ refresh_token: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDb();

      const hashedInput = hashToken(input.refresh_token);

      const sessionRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.refresh_token, hashedInput))
        .limit(1);

      if (sessionRows.length === 0) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid refresh token." });
      }

      const session = sessionRows[0]!;

      // Enforce a 30-day hard cap on how long a refresh token stays valid.
      const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const sessionAge = Date.now() - new Date(session.created_at).getTime();
      if (sessionAge > REFRESH_TTL_MS) {
        await db.delete(sessions).where(eq(sessions.id, session.id));
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Refresh token has expired. Please log in again." });
      }

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, session.user_id))
        .limit(1);

      if (userRows.length === 0 || !userRows[0]!.is_active) {
        await db.delete(sessions).where(eq(sessions.id, session.id));
        throw new TRPCError({ code: "UNAUTHORIZED", message: "User not found or inactive." });
      }

      const row = userRows[0]!;

      // Rotate: delete old session and issue a new one (single-use refresh token).
      await db.delete(sessions).where(eq(sessions.id, session.id));

      await enforceSessionLimit(db, row.id);

      const newSessionId = crypto.randomUUID();
      const newRefreshToken = crypto.randomBytes(32).toString("hex");
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

      await db.insert(sessions).values({
        id: newSessionId,
        user_id: row.id,
        expires_at: expiresAt,
        created_at: now,
        last_active_at: now,
        refresh_token: hashToken(newRefreshToken),
      });

      return {
        user: buildUserResponse(row),
        session: { id: newSessionId, user_id: row.id, expires_at: expiresAt, refresh_token: newRefreshToken },
      };
    }),

  /**
   * Revoke all sessions for the authenticated user (e.g. "log out everywhere").
   */
  revokeAllSessions: protectedProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    const deleted = await db
      .delete(sessions)
      .where(eq(sessions.user_id, ctx.user.id))
      .returning({ id: sessions.id });
    return { revokedCount: deleted.length };
  }),

  /**
   * Return the currently authenticated user.
   */
  me: protectedProcedure.query(({ ctx }) => {
    return ctx.user;
  }),

  /**
   * Create a new user account. Requires an authenticated admin caller.
   */
  createUser: protectedProcedure.input(createUserSchema).mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only admins can create user accounts.",
      });
    }

    const db = getDb();

    // Check for duplicate email.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    if (existing.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "A user with this email already exists.",
      });
    }

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();

    await db.insert(users).values({
      id: userId,
      email: input.email,
      password_hash: await hashPassword(input.password),
      name: input.name,
      role: input.role,
      specialty: input.specialty ?? null,
      department: input.department ?? null,
      is_active: true,
      created_at: now,
      updated_at: now,
    });

    const user: User = {
      id: userId,
      email: input.email,
      name: input.name,
      role: input.role,
      specialty: input.specialty,
      department: input.department,
      is_active: true,
      created_at: now,
      updated_at: now,
    };

    return user;
  }),

  // ---------- MFA management (protected) ----------

  /**
   * Begin MFA setup -- generates a TOTP secret and recovery codes.
   * Does NOT enable MFA yet; call mfa.verify to confirm and activate.
   */
  mfaSetup: protectedProcedure.mutation(async ({ ctx }) => {
    const db = getDb();

    // Prevent overwriting an active MFA configuration
    const existing = await db
      .select({ mfa_enabled: users.mfa_enabled })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    if (existing[0]?.mfa_enabled === true) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "MFA is already enabled. Disable MFA first before re-configuring.",
      });
    }

    const secret = generateSecret();
    const recoveryCodes = generateRecoveryCodes();
    const hashedCodes = recoveryCodes.map(hashRecoveryCode);

    // Store secret and hashed recovery codes, but don't enable MFA yet.
    await db
      .update(users)
      .set({
        mfa_secret: secret,
        recovery_codes: JSON.stringify(hashedCodes),
        updated_at: new Date().toISOString(),
      })
      .where(eq(users.id, ctx.user.id));

    const uri = buildOTPAuthURI(secret, ctx.user.email);

    return {
      secret,
      uri,
      recoveryCodes,
    };
  }),

  /**
   * Verify a TOTP code and enable MFA.
   * Must be called after mfaSetup with a valid code from the authenticator app.
   */
  mfaVerify: protectedProcedure
    .input(mfaVerifySchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // Fetch the stored (but not yet enabled) secret
      const rows = await db
        .select({ mfa_secret: users.mfa_secret })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      const row = rows[0];
      if (!row?.mfa_secret) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "MFA setup has not been initiated. Call mfaSetup first.",
        });
      }

      if (!verifyTOTP(row.mfa_secret, input.code)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid TOTP code. Please try again.",
        });
      }

      // Enable MFA
      await db
        .update(users)
        .set({
          mfa_enabled: true,
          updated_at: new Date().toISOString(),
        })
        .where(eq(users.id, ctx.user.id));

      return {
        enabled: true as const,
      };
    }),

  /**
   * Disable MFA. Requires a valid TOTP code.
   */
  mfaDisable: protectedProcedure
    .input(mfaDisableSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // Fetch the stored secret
      const rows = await db
        .select({ mfa_secret: users.mfa_secret, mfa_enabled: users.mfa_enabled })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      const row = rows[0];
      if (!row?.mfa_secret || row.mfa_enabled !== true) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "MFA is not currently enabled.",
        });
      }

      if (!verifyTOTP(row.mfa_secret, input.code)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid TOTP code.",
        });
      }

      // Disable MFA and clear secrets
      await db
        .update(users)
        .set({
          mfa_enabled: false,
          mfa_secret: null,
          recovery_codes: null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(users.id, ctx.user.id));

      return { disabled: true };
    }),
});

export type AuthRouter = typeof authRouter;
