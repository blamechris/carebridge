import { z } from "zod";

export const fhirBundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  type: z.enum([
    "document",
    "message",
    "transaction",
    "batch",
    "history",
    "searchset",
    "collection",
  ]),
  entry: z
    .array(
      z.object({
        fullUrl: z.string().optional(),
        resource: z
          .object({
            resourceType: z.string(),
            id: z.string().optional(),
          })
          .passthrough(),
      }),
    )
    .optional(),
}).passthrough();

export type FhirBundle = z.infer<typeof fhirBundleSchema>;
