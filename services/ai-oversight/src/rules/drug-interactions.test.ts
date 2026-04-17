import { describe, it, expect } from "vitest";
import { checkDrugInteractions } from "./drug-interactions.js";

describe("checkDrugInteractions", () => {
  describe("serotonin syndrome — SSRI/SNRI + tramadol", () => {
    it("flags sertraline + tramadol", () => {
      const flags = checkDrugInteractions(["sertraline 50mg", "tramadol 50mg"]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-TRAMADOL");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });

    it("flags fluoxetine + ultram (brand name)", () => {
      const flags = checkDrugInteractions(["fluoxetine 20mg", "ultram 100mg"]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-TRAMADOL");
      expect(match).toBeDefined();
    });

    it("flags SNRI venlafaxine + tramadol", () => {
      const flags = checkDrugInteractions(["venlafaxine 75mg", "tramadol 50mg"]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-TRAMADOL");
      expect(match).toBeDefined();
    });

    it("flags duloxetine + tramadol", () => {
      const flags = checkDrugInteractions(["duloxetine 60mg", "tramadol 50mg"]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-TRAMADOL");
      expect(match).toBeDefined();
    });
  });

  describe("serotonin syndrome — SSRI/SNRI + linezolid", () => {
    it("flags sertraline + linezolid", () => {
      const flags = checkDrugInteractions(["sertraline 100mg", "linezolid 600mg"]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-LINEZOLID");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });

    it("flags escitalopram + zyvox (brand name)", () => {
      const flags = checkDrugInteractions(["escitalopram 10mg", "zyvox 600mg"]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-LINEZOLID");
      expect(match).toBeDefined();
    });

    it("flags SNRI desvenlafaxine + linezolid", () => {
      const flags = checkDrugInteractions([
        "desvenlafaxine 50mg",
        "linezolid 600mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-LINEZOLID");
      expect(match).toBeDefined();
    });
  });

  describe("serotonin syndrome — SSRI/SNRI + dextromethorphan", () => {
    it("flags paroxetine + dextromethorphan", () => {
      const flags = checkDrugInteractions([
        "paroxetine 20mg",
        "dextromethorphan 30mg",
      ]);
      const match = flags.find(
        (f) => f.rule_id === "DI-SEROTONIN-DEXTROMETHORPHAN",
      );
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });
  });

  describe("serotonin syndrome — SSRI/SNRI + methylene blue", () => {
    it("flags citalopram + methylene blue", () => {
      const flags = checkDrugInteractions([
        "citalopram 20mg",
        "methylene blue 1mg/kg",
      ]);
      const match = flags.find(
        (f) => f.rule_id === "DI-SEROTONIN-METHYLENE-BLUE",
      );
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });
  });

  describe("existing SSRI/SNRI + MAOI rule still works", () => {
    it("flags fluoxetine + phenelzine", () => {
      const flags = checkDrugInteractions(["fluoxetine 20mg", "phenelzine 15mg"]);
      const match = flags.find((f) => f.rule_id === "DI-SSRI-MAOI");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });
  });

  describe("existing SSRI/SNRI + triptan rule still works", () => {
    it("flags sertraline + sumatriptan", () => {
      const flags = checkDrugInteractions([
        "sertraline 50mg",
        "sumatriptan 100mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-SSRI-TRIPTAN");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });
  });

  describe("ACE inhibitor + potassium-sparing diuretic — hyperkalemia", () => {
    it("flags lisinopril + spironolactone", () => {
      const flags = checkDrugInteractions(["lisinopril 10mg", "spironolactone 25mg"]);
      const match = flags.find((f) => f.rule_id === "DI-ACE-KSPARING");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags enalapril + amiloride", () => {
      const flags = checkDrugInteractions(["enalapril 5mg", "amiloride 5mg"]);
      const match = flags.find((f) => f.rule_id === "DI-ACE-KSPARING");
      expect(match).toBeDefined();
    });

    it("flags ramipril + eplerenone (brand inspra)", () => {
      const flags = checkDrugInteractions(["ramipril 5mg", "inspra 50mg"]);
      const match = flags.find((f) => f.rule_id === "DI-ACE-KSPARING");
      expect(match).toBeDefined();
    });

    it("flags captopril + triamterene", () => {
      const flags = checkDrugInteractions(["captopril 25mg", "triamterene 50mg"]);
      const match = flags.find((f) => f.rule_id === "DI-ACE-KSPARING");
      expect(match).toBeDefined();
    });
  });

  describe("lithium + ACE inhibitor — lithium toxicity", () => {
    it("flags lithium + lisinopril", () => {
      const flags = checkDrugInteractions(["lithium 300mg", "lisinopril 10mg"]);
      const match = flags.find((f) => f.rule_id === "DI-LITHIUM-ACE");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags lithobid + enalapril", () => {
      const flags = checkDrugInteractions(["lithobid 450mg", "enalapril 5mg"]);
      const match = flags.find((f) => f.rule_id === "DI-LITHIUM-ACE");
      expect(match).toBeDefined();
    });

    it("flags lithium + ramipril", () => {
      const flags = checkDrugInteractions(["lithium 600mg", "ramipril 5mg"]);
      const match = flags.find((f) => f.rule_id === "DI-LITHIUM-ACE");
      expect(match).toBeDefined();
    });
  });

  describe("fluoroquinolone + corticosteroid — tendon rupture", () => {
    it("flags ciprofloxacin + prednisone", () => {
      const flags = checkDrugInteractions(["ciprofloxacin 500mg", "prednisone 20mg"]);
      const match = flags.find((f) => f.rule_id === "DI-FLUOROQUINOLONE-CORTICOSTEROID");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags levofloxacin + dexamethasone", () => {
      const flags = checkDrugInteractions(["levofloxacin 750mg", "dexamethasone 4mg"]);
      const match = flags.find((f) => f.rule_id === "DI-FLUOROQUINOLONE-CORTICOSTEROID");
      expect(match).toBeDefined();
    });

    it("flags moxifloxacin + methylprednisolone", () => {
      const flags = checkDrugInteractions(["moxifloxacin 400mg", "methylprednisolone 40mg"]);
      const match = flags.find((f) => f.rule_id === "DI-FLUOROQUINOLONE-CORTICOSTEROID");
      expect(match).toBeDefined();
    });

    it("does not flag fluoroquinolone + inhaled budesonide (alert fatigue guard)", () => {
      const flags = checkDrugInteractions([
        "ciprofloxacin 500mg",
        "budesonide inhaler 180mcg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-FLUOROQUINOLONE-CORTICOSTEROID");
      expect(match).toBeUndefined();
    });

    it("does not flag fluoroquinolone + topical hydrocortisone (alert fatigue guard)", () => {
      const flags = checkDrugInteractions([
        "levofloxacin 500mg",
        "hydrocortisone cream 2.5%",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-FLUOROQUINOLONE-CORTICOSTEROID");
      expect(match).toBeUndefined();
    });

    it("does not flag fluoroquinolone + intranasal triamcinolone (alert fatigue guard)", () => {
      const flags = checkDrugInteractions([
        "moxifloxacin 400mg",
        "triamcinolone nasal spray 55mcg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-FLUOROQUINOLONE-CORTICOSTEROID");
      expect(match).toBeUndefined();
    });
  });

  describe("existing high-priority pairs coverage", () => {
    it("flags warfarin + ibuprofen (NSAID)", () => {
      const flags = checkDrugInteractions(["warfarin 5mg", "ibuprofen 400mg"]);
      const match = flags.find((f) => f.rule_id === "DI-WARFARIN-NSAID");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });

    it("flags digoxin + amiodarone", () => {
      const flags = checkDrugInteractions(["digoxin 0.125mg", "amiodarone 200mg"]);
      const match = flags.find((f) => f.rule_id === "DI-DIGOXIN-AMIODARONE");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });

    it("flags opioid + benzodiazepine (FDA black box)", () => {
      const flags = checkDrugInteractions(["oxycodone 10mg", "alprazolam 0.5mg"]);
      const match = flags.find((f) => f.rule_id === "DI-OPIOID-BENZO");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });

    it("flags metformin + contrast dye", () => {
      const flags = checkDrugInteractions(["metformin 500mg", "iodinated contrast"]);
      const match = flags.find((f) => f.rule_id === "DI-METFORMIN-CONTRAST");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags lithium + naproxen (NSAID)", () => {
      const flags = checkDrugInteractions(["lithium 300mg", "naproxen 500mg"]);
      const match = flags.find((f) => f.rule_id === "DI-LITHIUM-NSAID");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("critical");
    });

    it("flags theophylline + ciprofloxacin", () => {
      const flags = checkDrugInteractions(["theophylline 300mg", "ciprofloxacin 500mg"]);
      const match = flags.find((f) => f.rule_id === "DI-THEOPHYLLINE-CIPRO");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags potassium supplement + spironolactone", () => {
      const flags = checkDrugInteractions(["potassium chloride 20mEq", "spironolactone 25mg"]);
      const match = flags.find((f) => f.rule_id === "DI-POTASSIUM-SPIRONOLACTONE");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags warfarin + aspirin", () => {
      const flags = checkDrugInteractions(["warfarin 5mg", "aspirin 81mg"]);
      const match = flags.find((f) => f.rule_id === "DI-WARFARIN-ASPIRIN");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags ACE inhibitor + potassium supplement", () => {
      const flags = checkDrugInteractions([
        "lisinopril 10mg",
        "potassium chloride 20mEq",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-ACE-POTASSIUM");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });
  });

  describe("QTc-prolonging drug combinations (DI-QTC-COMBO)", () => {
    it("flags amiodarone + azithromycin (existing pair)", () => {
      const flags = checkDrugInteractions([
        "amiodarone 200mg",
        "azithromycin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warning");
    });

    it("flags haloperidol + methadone (existing pair)", () => {
      const flags = checkDrugInteractions([
        "haloperidol 5mg",
        "methadone 10mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    // Second-generation antipsychotics (Group A additions)
    it("flags quetiapine + azithromycin", () => {
      const flags = checkDrugInteractions([
        "quetiapine 200mg",
        "azithromycin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags risperidone + ondansetron", () => {
      const flags = checkDrugInteractions([
        "risperidone 2mg",
        "ondansetron 8mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags olanzapine + levofloxacin", () => {
      const flags = checkDrugInteractions([
        "olanzapine 10mg",
        "levofloxacin 750mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags ziprasidone + moxifloxacin", () => {
      const flags = checkDrugInteractions([
        "ziprasidone 40mg",
        "moxifloxacin 400mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags aripiprazole + clarithromycin", () => {
      const flags = checkDrugInteractions([
        "aripiprazole 10mg",
        "clarithromycin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags paliperidone + erythromycin", () => {
      const flags = checkDrugInteractions([
        "paliperidone 6mg",
        "erythromycin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags iloperidone + azithromycin", () => {
      const flags = checkDrugInteractions([
        "iloperidone 6mg",
        "azithromycin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    // Class IC antiarrhythmics (Group A additions)
    it("flags flecainide + azithromycin", () => {
      const flags = checkDrugInteractions([
        "flecainide 100mg",
        "azithromycin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags procainamide + ondansetron", () => {
      const flags = checkDrugInteractions([
        "procainamide 500mg",
        "ondansetron 4mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags disopyramide + methadone", () => {
      const flags = checkDrugInteractions([
        "disopyramide 150mg",
        "methadone 10mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    // Fluoroquinolones (Group B additions)
    it("flags amiodarone + ciprofloxacin", () => {
      const flags = checkDrugInteractions([
        "amiodarone 200mg",
        "ciprofloxacin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags sotalol + gemifloxacin", () => {
      const flags = checkDrugInteractions([
        "sotalol 80mg",
        "gemifloxacin 320mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags dofetilide + ofloxacin", () => {
      const flags = checkDrugInteractions([
        "dofetilide 500mcg",
        "ofloxacin 400mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    // Antiemetics / other additions (Group B)
    it("flags amiodarone + domperidone", () => {
      const flags = checkDrugInteractions([
        "amiodarone 200mg",
        "domperidone 10mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags haloperidol + hydroxychloroquine", () => {
      const flags = checkDrugInteractions([
        "haloperidol 5mg",
        "hydroxychloroquine 400mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags amiodarone + chloroquine", () => {
      const flags = checkDrugInteractions([
        "amiodarone 200mg",
        "chloroquine 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags sotalol + citalopram", () => {
      const flags = checkDrugInteractions([
        "sotalol 80mg",
        "citalopram 40mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags amiodarone + escitalopram", () => {
      const flags = checkDrugInteractions([
        "amiodarone 200mg",
        "escitalopram 20mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags haloperidol + donepezil", () => {
      const flags = checkDrugInteractions([
        "haloperidol 2mg",
        "donepezil 10mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    // Cross-class combinations (antipsychotic + fluoroquinolone)
    it("flags quetiapine + ciprofloxacin (antipsychotic + fluoroquinolone)", () => {
      const flags = checkDrugInteractions([
        "quetiapine 200mg",
        "ciprofloxacin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags olanzapine + moxifloxacin", () => {
      const flags = checkDrugInteractions([
        "olanzapine 10mg",
        "moxifloxacin 400mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    // Brand-name matching
    it("flags seroquel (quetiapine) + zithromax (azithromycin)", () => {
      const flags = checkDrugInteractions([
        "seroquel 200mg",
        "zithromax 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags cipro (ciprofloxacin) + haldol (haloperidol)", () => {
      const flags = checkDrugInteractions([
        "cipro 500mg",
        "haldol 5mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags pacerone (amiodarone) + lexapro (escitalopram)", () => {
      const flags = checkDrugInteractions([
        "pacerone 200mg",
        "lexapro 20mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags geodon (ziprasidone) + zofran (ondansetron)", () => {
      const flags = checkDrugInteractions([
        "geodon 40mg",
        "zofran 8mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    it("flags abilify (aripiprazole) + avelox (moxifloxacin)", () => {
      const flags = checkDrugInteractions([
        "abilify 10mg",
        "avelox 400mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeDefined();
    });

    // Same-drug-different-dose deduplication
    it("does not flag the same QT drug at different doses (amiodarone 200mg + 400mg)", () => {
      const flags = checkDrugInteractions([
        "amiodarone 200mg",
        "amiodarone 400mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeUndefined();
    });

    it("does not flag the same QT drug at different doses (sotalol 80mg + 160mg)", () => {
      const flags = checkDrugInteractions([
        "sotalol 80mg",
        "sotalol 160mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeUndefined();
    });

    // Negative / no-false-positive cases
    it("does not flag a single QT-prolonging drug alone", () => {
      const flags = checkDrugInteractions(["quetiapine 200mg"]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeUndefined();
    });

    it("does not flag two non-QT drugs", () => {
      const flags = checkDrugInteractions([
        "acetaminophen 500mg",
        "amoxicillin 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeUndefined();
    });

    it("does not flag the same QT drug listed twice (duplicate med entry)", () => {
      const flags = checkDrugInteractions([
        "sotalol 80mg",
        "sotalol 80mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-QTC-COMBO");
      expect(match).toBeUndefined();
    });
  });

  describe("no false positives", () => {
    it("does not flag unrelated medications", () => {
      const flags = checkDrugInteractions([
        "sertraline 50mg",
        "acetaminophen 500mg",
      ]);
      const serotoninFlags = flags.filter((f) =>
        f.rule_id.startsWith("DI-SEROTONIN"),
      );
      expect(serotoninFlags).toHaveLength(0);
    });

    it("does not flag a single serotonergic agent alone", () => {
      const flags = checkDrugInteractions(["sertraline 50mg"]);
      const serotoninFlags = flags.filter((f) =>
        f.rule_id.startsWith("DI-SEROTONIN"),
      );
      expect(serotoninFlags).toHaveLength(0);
    });

    it("does not flag tramadol without an SSRI/SNRI", () => {
      const flags = checkDrugInteractions([
        "tramadol 50mg",
        "acetaminophen 500mg",
      ]);
      const match = flags.find((f) => f.rule_id === "DI-SEROTONIN-TRAMADOL");
      expect(match).toBeUndefined();
    });
  });

  describe("multiple serotonergic interactions detected simultaneously", () => {
    it("flags both tramadol and linezolid when combined with an SSRI", () => {
      const flags = checkDrugInteractions([
        "sertraline 50mg",
        "tramadol 50mg",
        "linezolid 600mg",
      ]);
      const tramadolFlag = flags.find(
        (f) => f.rule_id === "DI-SEROTONIN-TRAMADOL",
      );
      const linezolidFlag = flags.find(
        (f) => f.rule_id === "DI-SEROTONIN-LINEZOLID",
      );
      expect(tramadolFlag).toBeDefined();
      expect(linezolidFlag).toBeDefined();
    });
  });
});
