import { z } from "zod";

export const noteTemplateTypeSchema = z.enum(["soap", "progress", "h_and_p", "discharge", "consult"]);
export const fieldSourceSchema = z.enum(["new_entry", "carried_forward", "modified"]);
export const noteStatusSchema = z.enum(["draft", "signed", "cosigned", "amended"]);

const noteFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.boolean(), z.number(), z.null()]),
  field_type: z.enum(["text", "textarea", "select", "multiselect", "checkbox", "number"]),
  source: fieldSourceSchema,
  options: z.array(z.string()).optional(),
});

const noteSectionSchema = z.object({
  key: z.string(),
  label: z.string(),
  fields: z.array(noteFieldSchema),
  free_text: z.string().max(50000).optional(),
});

export const createNoteSchema = z.object({
  patient_id: z.string().uuid(),
  provider_id: z.string().uuid(),
  encounter_id: z.string().uuid().optional(),
  template_type: noteTemplateTypeSchema,
  sections: z.array(noteSectionSchema).min(1),
});

export const updateNoteSchema = z.object({
  sections: z.array(noteSectionSchema).min(1),
  expectedVersion: z.number().int().positive().optional(),
});

export const signNoteSchema = z.object({
  signed_by: z.string().uuid(),
});

/**
 * Cosign a signed clinical note. The cosigner identity is always taken
 * from the authenticated caller at the gateway — never trusted from the
 * client payload — so this schema carries only the target note id.
 */
export const cosignNoteSchema = z.object({
  noteId: z.string().uuid(),
});

/**
 * Amend a signed or cosigned clinical note. Requires a non-empty reason
 * (trimmed) to satisfy HIPAA amendment audit semantics. The reason is
 * stored alongside the new version in the audit trail.
 */
export const amendNoteSchema = z.object({
  noteId: z.string().uuid(),
  sections: z.array(noteSectionSchema).min(1),
  reason: z
    .string()
    .trim()
    .min(1, "Amendment reason is required")
    .max(2000, "Amendment reason must be 2000 characters or fewer"),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type CosignNoteInput = z.infer<typeof cosignNoteSchema>;
export type AmendNoteInput = z.infer<typeof amendNoteSchema>;
