import { describe, it, expect } from "vitest";
import { toDoseQuantity, isUcumAllowed } from "./ucum.js";

describe("toDoseQuantity — UCUM validity (#946)", () => {
  it("emits full UCUM Quantity for atomic codes (mg, g, mL, kg, L)", () => {
    for (const u of ["mg", "g", "mL", "kg", "L"]) {
      const q = toDoseQuantity(100, u);
      expect(q.value).toBe(100);
      expect(q.unit).toBe(u);
      expect(q.system).toBe("http://unitsofmeasure.org");
      expect(q.code).toBe(u.toLowerCase());
    }
  });

  it("maps clinical 'mcg' to canonical UCUM 'ug' microgram", () => {
    const q = toDoseQuantity(500, "mcg");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("ug");
    expect(q.unit).toBe("mcg"); // clinician-readable unit preserved
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
