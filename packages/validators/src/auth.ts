import { z } from "zod";

export const userRoleSchema = z.enum(["patient", "nurse", "physician", "specialist", "admin"]);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(200),
  role: userRoleSchema,
  specialty: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
