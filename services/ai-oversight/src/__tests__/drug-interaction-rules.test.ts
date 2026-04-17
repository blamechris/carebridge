import { describe, it, expect } from "vitest";

import {
  checkDrugInteractions,
  QTC_PATTERN,
  BRAND_TO_GENERIC,
} from "../rules/drug-interactions.js";

describe("QTC_PATTERN ↔ BRAND_TO_GENERIC sync", () => {
  const alternates = QTC_PATTERN.source.split("|");

  it("every BRAND_TO_GENERIC key appears in QTC_PATTERN alternates", () => {
    for (const brand of Object.keys(BRAND_TO_GENERIC)) {
      expect(alternates).toContain(brand);
    }
  });

  it("every BRAND_TO_GENERIC value (generic) appears in QTC_PATTERN alternates", () => {
    const genericValues = [...new Set(Object.values(BRAND_TO_GENERIC))];
    for (const generic of genericValues) {
      expect(alternates).toContain(generic);
    }
  });

  it("every alternate is either a generic (not in BRAND_TO_GENERIC keys) or a known brand", () => {
    const brandKeys = new Set(Object.keys(BRAND_TO_GENERIC));
    const genericValues = new Set(Object.values(BRAND_TO_GENERIC));

    for (const alt of alternates) {
      const isBrand = brandKeys.has(alt);
      const isGeneric = !brandKeys.has(alt);
      // If it's a brand, it must map to a generic that's also in the pattern
      if (isBrand) {
        expect(genericValues).toContain(BRAND_TO_GENERIC[alt]);
        expect(alternates).toContain(BRAND_TO_GENERIC[alt]!);
      }
      // Every alternate must be accounted for: either a brand key or a standalone generic
      expect(isBrand || isGeneric).toBe(true);
    }
  });
});

describe("DI-QTC-COMBO brand/generic dedup", () => {
  describe("brand + generic of the SAME drug should NOT fire", () => {
    it("pacerone (brand) + amiodarone (generic)", () => {
      const flags = checkDrugInteractions(["pacerone 200mg", "amiodarone 400mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });

    it("cordarone (brand) + amiodarone (generic)", () => {
      const flags = checkDrugInteractions(["cordarone 200mg", "amiodarone 200mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });

    it("betapace (brand) + sotalol (generic)", () => {
      const flags = checkDrugInteractions(["betapace 80mg", "sotalol 120mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });

    it("haldol (brand) + haloperidol (generic)", () => {
      const flags = checkDrugInteractions(["haldol 5mg", "haloperidol 10mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });

    it("seroquel (brand) + quetiapine (generic)", () => {
      const flags = checkDrugInteractions(["seroquel 100mg", "quetiapine 200mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });

    it("zithromax (brand) + azithromycin (generic)", () => {
      const flags = checkDrugInteractions(["zithromax 250mg", "azithromycin 500mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });

    it("two brand names for the same generic (pacerone + cordarone → amiodarone)", () => {
      const flags = checkDrugInteractions(["pacerone 200mg", "cordarone 200mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });
  });

  describe("brand + generic of DIFFERENT drugs SHOULD fire", () => {
    it("pacerone (amiodarone brand) + seroquel (quetiapine brand)", () => {
      const flags = checkDrugInteractions(["pacerone 200mg", "seroquel 100mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(1);
    });

    it("haldol (haloperidol brand) + zithromax (azithromycin brand)", () => {
      const flags = checkDrugInteractions(["haldol 5mg", "zithromax 500mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(1);
    });

    it("betapace (sotalol brand) + geodon (ziprasidone brand)", () => {
      const flags = checkDrugInteractions(["betapace 80mg", "geodon 40mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(1);
    });

    it("tikosyn (dofetilide brand) + risperdal (risperidone brand)", () => {
      const flags = checkDrugInteractions(["tikosyn 500mcg", "risperdal 2mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(1);
    });

    it("zyprexa (olanzapine brand) + amiodarone (generic)", () => {
      const flags = checkDrugInteractions(["zyprexa 10mg", "amiodarone 200mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(1);
    });
  });

  describe("generic + generic dedup still works", () => {
    it("same generic twice does NOT fire", () => {
      const flags = checkDrugInteractions(["amiodarone 200mg", "amiodarone 400mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(0);
    });

    it("two different generics SHOULD fire", () => {
      const flags = checkDrugInteractions(["amiodarone 200mg", "haloperidol 5mg"]);
      const qtc = flags.filter((f) => f.rule_id === "DI-QTC-COMBO");
      expect(qtc).toHaveLength(1);
    });
  });
});
