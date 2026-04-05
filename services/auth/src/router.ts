import { TRPCError, initTRPC } from "@trpc/server";
import type { User } from "@carebridge/shared-types";
import { loginSchema, createUserSchema } from "@carebridge/validators";
import { getDb, users, sessions } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "./password.js";

// ---------- tRPC setup (mirrors api-gateway's context shape) ----------

interface Context {
  db: ReturnType<typeof getDb>;
  user: User | null;
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

// 24 hours absolute TTL; idle timeout enforced separately in auth middleware
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ---------- Router ----------

export const authRouter = t.router({
  /**
   * Log in with email + password.
   * Dev mode: simple string comparison against stored hash.
   */
  login: publicProcedure.input(loginSchema).mutation(async ({ input }) => {
    const db = getDb();

    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    if (userRows.length === 0) {
      // Perform a dummy hash to prevent timing-based user enumeration
      await hashPassword("dummy-timing-equalization");
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid email or password.",
      });
    }

    const row = userRows[0]!;

    const passwordValid = await verifyPassword(input.password, row.password_hash);
    if (!passwordValid) {
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

    // Create session.
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await db.insert(sessions).values({
      id: sessionId,
      user_id: row.id,
      expires_at: expiresAt,
    });

    const user: User = {
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

    return {
      user,
      session: { id: sessionId, user_id: row.id, expires_at: expiresAt },
    };
  }),

  /**
   * Log out -- deletes the caller's session.
   */
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    const db = getDb();

    // Delete all sessions for the current user (simple approach for dev).
    await db.delete(sessions).where(eq(sessions.user_id, ctx.user.id));

    return { success: true };
  }),

  /**
   * Return the currently authenticated user.
   */
  me: protectedProcedure.query(({ ctx }) => {
    return ctx.user;
  }),

  /**
   * Register a new patient account (public — patients self-register).
   */
  registerPatient: publicProcedure
    .input(createUserSchema.extend({ role: z.literal("patient") }))
    .mutation(async ({ input }) => {
      const db = getDb();

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
        role: "patient",
        specialty: null,
        department: null,
        is_active: true,
        created_at: now,
        updated_at: now,
      });

      const user: User = {
        id: userId,
        email: input.email,
        name: input.name,
        role: "patient",
        is_active: true,
        created_at: now,
        updated_at: now,
      };

      return user;
    }),

  /**
   * Create a clinical or admin user account.
   * Requires the caller to be authenticated with the "admin" role.
   */
  createUser: protectedProcedure.input(createUserSchema).mutation(async ({ input, ctx }) => {
    if (input.role !== "patient" && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Only administrators can create accounts with clinical or admin roles.",
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
});

export type AuthRouter = typeof authRouter;
