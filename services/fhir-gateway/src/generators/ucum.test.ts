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

describe("toDoseQuantity — UCUM-lhc validator integration (#978)", () => {
  // The pre-#978 hand-curated allowlist gated out valid UCUM expressions
  // that aren't on the dosing short-list. After integrating @lhncbc/ucum-lhc
  // (NIH/NLM reference implementation), the validator accepts any
  // syntactically valid UCUM expression while we keep the alias table for
  // legacy curly-brace forms (`{tbl}`, `{puff}`, etc.) and `mcg → ug`.

  it("accepts exotic-but-valid UCUM exponent forms (10*6/uL)", () => {
    // Cell-count units in haematology labs are commonly written as
    // 10*6/uL (10^6 cells per microlitre). Pre-#978 the hand-curated
    // allowlist rejected this; the lhc validator should accept it.
    const q = toDoseQuantity(4.5, "10*6/uL");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("10*6/uL");
    expect(q.unit).toBe("10*6/uL");
  });

  it("accepts product/exponent compound UCUM (mg.kg-1.d-1)", () => {
    // Pharmacokinetics commonly uses dot-product / negative-exponent
    // notation rather than the slash form (mg/kg/d).
    const q = toDoseQuantity(2, "mg.kg-1.d-1");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("mg.kg-1.d-1");
  });

  it("accepts arbitrary-unit per-volume forms ([iU]/mL, U/L)", () => {
    expect(toDoseQuantity(40, "[iU]/mL").code).toBe("[iU]/mL");
    expect(toDoseQuantity(25, "U/L").code).toBe("U/L");
  });

  it("accepts other valid UCUM expressions that were absent from the hand-curated allowlist", () => {
    // None of these were in the original UCUM_ALLOWLIST but all are
    // syntactically valid UCUM; the lhc validator should let them through.
    expect(toDoseQuantity(60, "mL/min").code).toBe("mL/min");
    expect(toDoseQuantity(5, "ug/min").code).toBe("ug/min");
    expect(toDoseQuantity(1, "mol/L").code).toBe("mol/L");
    // Proper UCUM blood-pressure form is mm[Hg] (the bracketed Hg atom).
    expect(toDoseQuantity(15, "mm[Hg]").code).toBe("mm[Hg]");
  });

  it("preserves canonical alias mapping for legacy 'mcg' compounds the validator rejects", () => {
    // 'mcg' itself is not strict UCUM. The validator returns invalid;
    // we keep the NON_UCUM_TO_UCUM_CODE table mapping it to canonical 'ug'.
    expect(toDoseQuantity(500, "mcg").code).toBe("ug");
    expect(toDoseQuantity(5, "mcg/h").code).toBe("ug/h");
    expect(toDoseQuantity(2, "mcg/kg").code).toBe("ug/kg");
  });

  it("canonicalises case-variant inputs to UCUM-canonical form", () => {
    // 'mcg/H' (uppercase H) is not in the static alias table but the
    // lowercased lookup hits 'mcg/h' → 'ug/h'. Verifies case-insensitive
    // alias lookup uniformly produces canonical UCUM.
    expect(toDoseQuantity(5, "MCG/H").code).toBe("ug/h");
    expect(toDoseQuantity(5, "Mcg/h").code).toBe("ug/h");
  });

  it("falls back to text-only Quantity for anything the validator and alias table both reject", () => {
    // 'scoop' is neither a UCUM expression nor an alias.
    const q = toDoseQuantity(1, "scoop");
    expect(q.system).toBeUndefined();
    expect(q.code).toBeUndefined();
    expect(q.unit).toBe("scoop");
  });

  it("rejects empty / whitespace-only inputs as text-only (defensive guard)", () => {
    // The lhc validator throws/errors on empty input; ensure we handle
    // it gracefully without leaking stderr noise from validateUnitString.
    expect(toDoseQuantity(1, "").code).toBeUndefined();
    expect(toDoseQuantity(1, "   ").code).toBeUndefined();
  });
});

describe("toDoseQuantity — clinical case-variant aliases (#1148)", () => {
  // PR #1138 replaced the hand-curated allowlist with the @lhncbc/ucum-lhc
  // validator, which is strictly case-sensitive. Several case-variant inputs
  // the pre-#1138 allowlist accepted now lose their system+code:
  //  - mEq → text-only (was: meq)
  //  - KG → text-only (was: kg)
  //  - mg/Kg, Mg/Kg → text-only (was: mg/kg)
  //  - G → 'G' (gauss, magnetic flux density!) instead of 'g' (gram)
  //
  // The clinical-context fix is a small alias table consulted BEFORE the
  // strict validator: case-variants that are unambiguously clinical
  // (clinicians never mean magnetic flux when typing "G" in a dose_unit)
  // are normalised to their canonical UCUM atom.
  it("maps 'mEq' to UCUM 'meq' (milliequivalent)", () => {
    const q = toDoseQuantity(10, "mEq");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("meq");
    expect(q.unit).toBe("mEq"); // original casing preserved
  });

  it("maps 'mEq/L' to UCUM 'meq/L'", () => {
    const q = toDoseQuantity(140, "mEq/L");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("meq/L");
    expect(q.unit).toBe("mEq/L");
  });

  it("maps 'KG' to UCUM 'kg' (kilogram)", () => {
    const q = toDoseQuantity(70, "KG");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("kg");
    expect(q.unit).toBe("KG");
  });

  it("maps 'mg/Kg' to UCUM 'mg/kg'", () => {
    const q = toDoseQuantity(2.5, "mg/Kg");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("mg/kg");
    expect(q.unit).toBe("mg/Kg");
  });

  it("maps 'Mg/Kg' to UCUM 'mg/kg'", () => {
    const q = toDoseQuantity(2.5, "Mg/Kg");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("mg/kg");
    expect(q.unit).toBe("Mg/Kg");
  });

  it("maps bare 'G' to UCUM 'g' (gram, NOT gauss)", () => {
    // CRITICAL semantic-regression guard. The strict UCUM atom 'G' is
    // gauss (magnetic flux density). In any clinical dose_unit context,
    // a clinician typing 'G' means grams. Without the case-alias map,
    // toDoseQuantity(1, "G") would emit code: "G" (gauss) — silently
    // re-interpreting "1 gram" as "1 gauss" in the FHIR export.
    const q = toDoseQuantity(1, "G");
    expect(q.system).toBe("http://unitsofmeasure.org");
    expect(q.code).toBe("g"); // gram, NOT gauss ("G")
    expect(q.unit).toBe("G"); // original input preserved
  });

  it("does not pollute the alias map via prototype keys", () => {
    // Defence-in-depth: a null-prototype alias map should never return
    // anything for __proto__ / constructor, so even an alias-table-only
    // path cannot leak a non-string code.
    const q = toDoseQuantity(1, "__proto__");
    if (q.code !== undefined) {
      expect(typeof q.code).toBe("string");
    }
  });

  it("leaves unknown case variants to the strict validator", () => {
    // 'scoop' is not in any alias table; the validator rejects it; result
    // must remain text-only Quantity (no system, no code).
    const q = toDoseQuantity(1, "scoop");
    expect(q.system).toBeUndefined();
    expect(q.code).toBeUndefined();
  });
});

describe("toDoseQuantity — prototype-pollution defence (#1138 Copilot review)", () => {
  // `medications.dose_unit` is free-text clinician input flowing through
  // tRPC → BullMQ → fhir-gateway. The alias table is a Record<string,string>
  // backed by `Object.create(null)`, but defence-in-depth `typeof === "string"`
  // guards in the lookup sites ensure that even if the table is ever
  // refactored back to a plain object, prototype-chain lookups on inputs
  // like `__proto__` / `constructor` cannot leak non-string `code` values
  // into the emitted FHIR Quantity. The validator itself may still accept
  // the literal string as a UCUM annotation, but the FHIR shape contract
  // (`code` is a string when present) must hold.
  it("never emits a non-string `code` for `__proto__` input", () => {
    const q = toDoseQuantity(1, "__proto__");
    if (q.code !== undefined) {
      expect(typeof q.code).toBe("string");
    }
  });

  it("never emits a non-string `code` for `constructor` input", () => {
    const q = toDoseQuantity(1, "constructor");
    if (q.code !== undefined) {
      expect(typeof q.code).toBe("string");
    }
  });

  it("never emits a non-string `code` for Object.prototype method names", () => {
    for (const name of [
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "valueOf",
      "toString",
    ]) {
      const q = toDoseQuantity(1, name);
      if (q.code !== undefined) {
        expect(typeof q.code).toBe("string");
      }
    }
  });

  it("does not crash isUcumAllowed on prototype-key inputs", () => {
    for (const name of [
      "__proto__",
      "constructor",
      "hasOwnProperty",
      "toString",
    ]) {
      // Just assert it returns a boolean without throwing — the predicate's
      // semantic answer is incidental, what matters is no prototype-object
      // leak through the alias-lookup branch.
      expect(typeof isUcumAllowed(name)).toBe("boolean");
    }
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

  it("accepts clinical case-variants restored by #1148 (mirror of toDoseQuantity)", () => {
    // Predicate must stay aligned with toDoseQuantity — anything the
    // emitter encodes as system+code MUST be reported allowed here, or
    // callers gating on `isUcumAllowed` get a different verdict than
    // what shows up in the emitted FHIR Quantity. Covers the new
    // CLINICAL_CASE_ALIASES branch in isUcumAllowed.
    expect(isUcumAllowed("G")).toBe(true); // gram, not gauss
    expect(isUcumAllowed("KG")).toBe(true);
    expect(isUcumAllowed("mEq")).toBe(true);
    expect(isUcumAllowed("mEq/L")).toBe(true);
    expect(isUcumAllowed("mg/Kg")).toBe(true);
    expect(isUcumAllowed("Mg/Kg")).toBe(true);
  });
});
