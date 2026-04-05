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
});

export const signNoteSchema = z.object({
  signed_by: z.string().uuid(),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
