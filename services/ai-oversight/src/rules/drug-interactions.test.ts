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
