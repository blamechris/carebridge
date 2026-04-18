import { describe, it, expect } from "vitest";
import {
  noteTemplateTypeSchema,
  fieldSourceSchema,
  noteStatusSchema,
  createNoteSchema,
  updateNoteSchema,
  signNoteSchema,
} from "../notes.js";

const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const validSection = {
  key: "subjective",
  label: "Subjective",
  fields: [
    {
      key: "chief_complaint",
      label: "Chief Complaint",
      value: "Headache for 3 days",
      field_type: "text" as const,
      source: "new_entry" as const,
    },
  ],
};

// ─── Template Type Enum ────────────────────────────────────────

describe("noteTemplateTypeSchema", () => {
  it("accepts all valid template types", () => {
    for (const type of ["soap", "progress", "h_and_p", "discharge", "consult"]) {
      expect(noteTemplateTypeSchema.safeParse(type).success, `Expected "${type}" to pass`).toBe(true);
    }
  });

  it("rejects invalid template types", () => {
    for (const type of ["SOAP", "referral", "admission", ""]) {
      expect(noteTemplateTypeSchema.safeParse(type).success, `Expected "${type}" to fail`).toBe(false);
    }
  });
});

// ─── Field Source Enum ─────────────────────────────────────────

describe("fieldSourceSchema", () => {
  it("accepts all valid field sources", () => {
    for (const source of ["new_entry", "carried_forward", "modified"]) {
      expect(fieldSourceSchema.safeParse(source).success, `Expected "${source}" to pass`).toBe(true);
    }
  });

  it("rejects invalid field sources", () => {
    expect(fieldSourceSchema.safeParse("auto").success).toBe(false);
  });
});

// ─── Note Status Enum ──────────────────────────────────────────

describe("noteStatusSchema", () => {
  it("accepts all valid note statuses", () => {
    for (const status of ["draft", "signed", "cosigned", "amended"]) {
      expect(noteStatusSchema.safeParse(status).success, `Expected "${status}" to pass`).toBe(true);
    }
  });

  it("rejects invalid note statuses", () => {
    expect(noteStatusSchema.safeParse("finalized").success).toBe(false);
  });
});

// ─── Create Note ───────────────────────────────────────────────

describe("createNoteSchema", () => {
  const validNote = {
    patient_id: UUID,
    provider_id: UUID,
    template_type: "soap" as const,
    sections: [validSection],
  };

  it("accepts valid note with required fields", () => {
    const result = createNoteSchema.safeParse(validNote);
    expect(result.success).toBe(true);
  });

  it("accepts note with optional encounter_id", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      encounter_id: UUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID patient_id", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      patient_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID provider_id", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      provider_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID encounter_id", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      encounter_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty sections array", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      sections: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid template_type", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      template_type: "referral",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(createNoteSchema.safeParse({}).success).toBe(false);
  });

  it("accepts section with free_text", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      sections: [{ ...validSection, free_text: "Additional notes here." }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects free_text exceeding 50000 characters", () => {
    const result = createNoteSchema.safeParse({
      ...validNote,
      sections: [{ ...validSection, free_text: "A".repeat(50001) }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid field_type values", () => {
    const fieldTypes = ["text", "textarea", "select", "multiselect", "checkbox", "number"];
    for (const ft of fieldTypes) {
      const section = {
        ...validSection,
        fields: [{ ...validSection.fields[0], field_type: ft }],
      };
      const result = createNoteSchema.safeParse({ ...validNote, sections: [section] });
      expect(result.success, `Expected field_type "${ft}" to pass`).toBe(true);
    }
  });

  it("rejects invalid field_type", () => {
    const section = {
      ...validSection,
      fields: [{ ...validSection.fields[0], field_type: "dropdown" }],
    };
    const result = createNoteSchema.safeParse({ ...validNote, sections: [section] });
    expect(result.success).toBe(false);
  });

  it("accepts various value types in fields", () => {
    const values = ["text value", ["a", "b"], true, 42, null];
    for (const value of values) {
      const section = {
        ...validSection,
        fields: [{ ...validSection.fields[0], value }],
      };
      const result = createNoteSchema.safeParse({ ...validNote, sections: [section] });
      expect(result.success, `Expected value ${JSON.stringify(value)} to pass`).toBe(true);
    }
  });

  it("accepts field with optional options array", () => {
    const section = {
      ...validSection,
      fields: [{ ...validSection.fields[0], field_type: "select", options: ["opt1", "opt2"] }],
    };
    const result = createNoteSchema.safeParse({ ...validNote, sections: [section] });
    expect(result.success).toBe(true);
  });
});

// ─── Update Note ───────────────────────────────────────────────

describe("updateNoteSchema", () => {
  it("accepts valid update with sections", () => {
    const result = updateNoteSchema.safeParse({ sections: [validSection] });
    expect(result.success).toBe(true);
  });

  it("accepts update with optional expectedVersion", () => {
    const result = updateNoteSchema.safeParse({
      sections: [validSection],
      expectedVersion: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty sections array", () => {
    const result = updateNoteSchema.safeParse({ sections: [] });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive expectedVersion", () => {
    const result = updateNoteSchema.safeParse({
      sections: [validSection],
      expectedVersion: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer expectedVersion", () => {
    const result = updateNoteSchema.safeParse({
      sections: [validSection],
      expectedVersion: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

// ─── Sign Note ─────────────────────────────────────────────────

describe("signNoteSchema", () => {
  it("accepts valid UUID for signed_by", () => {
    const result = signNoteSchema.safeParse({ signed_by: UUID });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID signed_by", () => {
    const result = signNoteSchema.safeParse({ signed_by: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects missing signed_by", () => {
    const result = signNoteSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
