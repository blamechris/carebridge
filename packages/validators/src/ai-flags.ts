import { z } from "zod";

export const flagSeveritySchema = z.enum(["critical", "warning", "info"]);
export const flagCategorySchema = z.enum([
  "cross-specialty", "drug-interaction", "care-gap",
  "critical-value", "trend-concern", "documentation-discrepancy",
]);
export const flagStatusSchema = z.enum(["open", "acknowledged", "resolved", "dismissed", "escalated"]);

export const acknowledgeFlagSchema = z.object({
  acknowledged_by: z.string().uuid(),
});

export const resolveFlagSchema = z.object({
  resolved_by: z.string().uuid(),
  resolution_note: z.string().min(1).max(2000),
});

export const dismissFlagSchema = z.object({
  dismissed_by: z.string().uuid(),
  dismiss_reason: z.string().min(1).max(2000),
});
