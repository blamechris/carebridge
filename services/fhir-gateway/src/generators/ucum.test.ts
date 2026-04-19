import { describe, it, expect } from "vitest";
import { toDoseQuantity, isUcumAllowed } from "./ucum.js";

describe("toDoseQuantity — UCUM validity (#946)", () => {
  it("emits full UCUM Quantity for atomic codes (mg, g, mL, kg, L)", () => {
    // UCUM is case-sensitive: `L`/`mL` are canonical, `l`/`ml` are not
    // the case-sensitive atoms most validators expect. Assert the
    // canonical casing is what we emit.
    const cases: Array<[string, string]> = [
      ["mg", "mg"],
      ["g", "g"],
      ["mL", "mL"],
      ["kg", "kg"],
      ["L", "L"],
    ];
    for (const [input, expectedCode] of cases) {
      const q = toDoseQuantity(100, input);
      expect(q.value).toBe(100);
      expect(q.unit).toBe(input);
      expect(q.system).toBe("http://unitsofmeasure.org");
      expect(q.code).toBe(expectedCode);
    }
  });

  it("emits canonical UCUM casing for mixed-case inputs (ml → mL, l → L, dl → dL)", () => {
    // Regression guard: lowercase inputs must map to the case-sensitive
    // UCUM form the rest of the gateway already uses in observation.ts
    // (mg/dL, mmol/L, ng/mL).
    expect(toDoseQuantity(10, "ml").code).toBe("mL");
    expect(toDoseQuantity(1, "l").code).toBe("L");
    expect(toDoseQuantity(1, "dl").code).toBe("dL");
    expect(toDoseQuantity(5, "mmol/l").code).toBe("mmol/L");
    expect(toDoseQuantity(150, "mg/dl").code).toBe("mg/dL");
    expect(toDoseQuantity(50, "ng/ml").code).toBe("ng/mL");
  });

  it("maps clinical 'mcg' to canonical UCUM 'ug' microgram", () => {
    const q = toDoseQuantity(500, "mcg");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("ug");
    expect(q.unit).toBe("mcg"); // clinician-readable unit preserved
  });

  it("maps 'mcg/h' and 'mcg/kg' compounds to canonical 'ug/...' UCUM", () => {
    expect(toDoseQuantity(5, "mcg/h").code).toBe("ug/h");
    expect(toDoseQuantity(2, "mcg/kg").code).toBe("ug/kg");
    expect(toDoseQuantity(10, "mcg/min").code).toBe("ug/min");
  });

  it("emits full UCUM Quantity for compound codes (mg/kg, mg/m2)", () => {
    const q = toDoseQuantity(2.5, "mg/kg");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("mg/kg");
  });

  it("maps 'IU' to [iU] UCUM annotation", () => {
    const q = toDoseQuantity(10000, "IU");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("[iU]");
    expect(q.unit).toBe("IU"); // human-readable preserved
  });

  it("maps 'units' / 'Unit' to [iU]", () => {
    expect(toDoseQuantity(50, "units").code).toBe("[iU]");
    expect(toDoseQuantity(50, "Unit").code).toBe("[iU]");
  });

  it("maps 'tablet' / 'tablets' / 'tab' to {tbl} annotation", () => {
    expect(toDoseQuantity(1, "tablet").code).toBe("{tbl}");
    expect(toDoseQuantity(2, "tablets").code).toBe("{tbl}");
    expect(toDoseQuantity(1, "tab").code).toBe("{tbl}");
  });

  it("maps 'capsule', 'puff', 'drop', 'spray', 'patch'", () => {
    expect(toDoseQuantity(1, "capsule").code).toBe("{cap}");
    expect(toDoseQuantity(2, "puff").code).toBe("{puff}");
    expect(toDoseQuantity(1, "drop").code).toBe("{drop}");
    expect(toDoseQuantity(1, "spray").code).toBe("{spray}");
    expect(toDoseQuantity(1, "patch").code).toBe("{patch}");
  });

  it("omits system + code for truly unknown units (text-only Quantity)", () => {
    const q = toDoseQuantity(1, "scoop");
    expect(q.value).toBe(1);
    expect(q.unit).toBe("scoop");
    expect(q.system).toBeUndefined();
    expect(q.code).toBeUndefined();
  });

  it("is case-insensitive on lookup but preserves input unit in output", () => {
    const q = toDoseQuantity(5, "MG");
    expect(q.code).toBe("mg");
    expect(q.unit).toBe("MG"); // original casing preserved
  });

  it("trims whitespace for lookup", () => {
    const q = toDoseQuantity(5, "  mg ");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("mg");
  });
});

describe("isUcumAllowed", () => {
  it("accepts the common mass / volume / time codes", () => {
    for (const u of ["mg", "g", "mL", "L", "ug", "kg"]) {
      expect(isUcumAllowed(u)).toBe(true);
    }
  });

  it("accepts lowercase volume forms via case-insensitive lookup", () => {
    for (const u of ["ml", "l", "dl"]) {
      expect(isUcumAllowed(u)).toBe(true);
    }
  });

  it("accepts derived dose units (mg/kg, mg/m2)", () => {
    expect(isUcumAllowed("mg/kg")).toBe(true);
    expect(isUcumAllowed("mg/m2")).toBe(true);
  });

  it("rejects annotation-only units (tablet / puff — need mapping first)", () => {
    expect(isUcumAllowed("tablet")).toBe(false);
    expect(isUcumAllowed("puff")).toBe(false);
  });

  it("rejects truly invalid strings", () => {
    expect(isUcumAllowed("scoop")).toBe(false);
    expect(isUcumAllowed("")).toBe(false);
  });
});
