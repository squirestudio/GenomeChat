import { describe, it, expect } from "vitest";
import { rankAssociations, classifyTrait, negLogP, formatP, effectPhrase, NEG_LOG_CAP } from "./gwas";

/* Shaped like real APOE output, where six of nine associations are molecular
   measurements and Alzheimer's — the best-known association this gene has —
   would otherwise be buried among them. */
const APOE = [
  { trait: "nectin-2 measurement", rsid: "rs2972555", p_value: 3e-30, beta: 0.0715, beta_unit: "unit", beta_direction: "increase" },
  { trait: "Alzheimer disease", rsid: "rs429358", p_value: 1e-19, odds_ratio: 3.2 },
  { trait: "triglyceride measurement", rsid: "rs7412", p_value: 2e-12, beta: -0.14, beta_unit: "unit", beta_direction: "decrease" },
  { trait: "memory performance", rsid: "rs429358", p_value: 4e-8, beta: -0.03, beta_unit: "z score" },
  { trait: "body height", rsid: "rs10413089", p_value: 2e-20, beta: 0.21, beta_unit: null },
];

describe("classifyTrait", () => {
  it("recognises a molecular measurement", () => {
    expect(classifyTrait("nectin-2 measurement")).toBe("measurement");
    expect(classifyTrait("level of tumor necrosis factor ligand")).toBe("measurement");
    expect(classifyTrait("AARSD1/RWDD1 protein level ratio")).toBe("measurement");
    expect(classifyTrait("leukocyte quantity")).toBe("measurement");
  });

  it("recognises a condition", () => {
    expect(classifyTrait("Alzheimer disease")).toBe("condition");
    expect(classifyTrait("body height")).toBe("condition");
    expect(classifyTrait("memory performance")).toBe("condition");
  });

  it("defaults to condition rather than dropping an unfamiliar trait", () => {
    expect(classifyTrait("something entirely new")).toBe("condition");
    expect(classifyTrait(null)).toBe("condition");
  });
});

describe("negLogP", () => {
  it("converts a p-value to something comparable", () => {
    expect(negLogP(1e-20)).toBeCloseTo(20, 6);
    expect(negLogP(0.05)).toBeCloseTo(1.301, 3);
  });

  it("caps an underflowed p rather than returning Infinity", () => {
    /* Studies report p = 0 when the value underflows float64. Infinity would
       flatten every other bar to nothing. */
    expect(negLogP(0)).toBe(NEG_LOG_CAP);
    expect(Number.isFinite(negLogP(0))).toBe(true);
  });

  it("rejects nonsense rather than plotting it", () => {
    expect(negLogP(null)).toBeNull();
    expect(negLogP(-1)).toBeNull();
    expect(negLogP("abc")).toBeNull();
  });
});

describe("formatP", () => {
  it("writes significance the way papers do", () => {
    expect(formatP(1e-19)).toBe("p = 1e-19");
    expect(formatP(0.03)).toBe("p = 0.030");
  });

  it("says less than, rather than zero, for an underflowed value", () => {
    expect(formatP(0)).toBe("p < 1e-300");
  });
});

describe("effectPhrase", () => {
  it("prefers an odds ratio, which is comparable, when present", () => {
    expect(effectPhrase({ odds_ratio: 3.2 })).toEqual({ direction: "up", text: "odds ratio 3.20" });
    expect(effectPhrase({ odds_ratio: 0.7 }).direction).toBe("down");
  });

  it("keeps a beta's own unit attached", () => {
    /* Betas are in whatever the study measured; the unit is the only thing
       that makes the number mean anything. */
    expect(effectPhrase({ beta: -0.03, beta_unit: "z score" }).text).toBe("-0.03 z score");
  });

  it("drops the catalogue's placeholder unit", () => {
    /* "unit" is what the GWAS Catalog records when a study named none. Printing
       it reads as though it did. */
    expect(effectPhrase({ beta: 0.072, beta_unit: "unit" }).text).toBe("+0.072");
    expect(effectPhrase({ beta: 0.072, beta_unit: "nmol/L" }).text).toBe("+0.072 nmol/L");
  });

  it("treats a missing p-value as absent, not as the most significant possible", () => {
    /* Number(null) is 0, and p = 0 is the strongest result there is. */
    expect(negLogP(null)).toBeNull();
    expect(negLogP(undefined)).toBeNull();
    expect(negLogP("")).toBeNull();
  });

  it("trusts the stated direction over the sign", () => {
    expect(effectPhrase({ beta: 0.14, beta_direction: "decrease" }).direction).toBe("down");
  });

  it("falls back to the sign when no direction is stated", () => {
    expect(effectPhrase({ beta: -0.5 }).direction).toBe("down");
    expect(effectPhrase({ beta: 0.5 }).direction).toBe("up");
  });

  it("says nothing rather than inventing an effect", () => {
    expect(effectPhrase({}).text).toBeNull();
    expect(effectPhrase({ beta: null, odds_ratio: null }).direction).toBeNull();
  });
});

describe("rankAssociations", () => {
  it("separates conditions from molecular measurements", () => {
    const { conditions, measurements } = rankAssociations(APOE);
    expect(conditions.map(c => c.trait)).toContain("Alzheimer disease");
    expect(measurements.map(m => m.trait)).toContain("nectin-2 measurement");
  });

  it("stops the best-known association being buried", () => {
    /* Ranked together, nectin-2 measurement at p=3e-30 outranks Alzheimer's at
       p=1e-19 — which is true and completely unhelpful. */
    const { conditions } = rankAssociations(APOE);
    expect(conditions[0].trait).toBe("body height");   // strongest condition
    expect(conditions.map(c => c.trait)).toContain("Alzheimer disease");
  });

  it("ranks by significance within each group", () => {
    const { measurements } = rankAssociations(APOE);
    const values = measurements.map(m => m.negLog);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("scales bars within a group, never across them", () => {
    /* Comparing a disease association against a protein-level one on one axis
       is the mixing this separation exists to prevent. */
    const { conditions, measurements } = rankAssociations(APOE);
    expect(conditions[0].relative).toBe(1);
    expect(measurements[0].relative).toBe(1);
  });

  it("reports the totals in each group", () => {
    const r = rankAssociations(APOE);
    expect(r.conditionTotal).toBe(3);
    expect(r.measurementTotal).toBe(2);
  });

  it("drops associations with no usable p-value", () => {
    const withJunk = [...APOE, { trait: "broken", p_value: null }];
    const r = rankAssociations(withJunk);
    expect([...r.conditions, ...r.measurements].find(x => x.trait === "broken")).toBeUndefined();
  });

  it("is safe on nothing", () => {
    expect(rankAssociations([]).conditions).toEqual([]);
    expect(rankAssociations(null).measurements).toEqual([]);
  });
});

describe("risk allele frequency", () => {
  // Fetched from the GWAS Catalog and previously dropped in the mapper, so the
  // panel could not tell a common risk allele from a rare one. A strong
  // association with something 2% of people carry reads very differently from
  // one with something 60% carry.
  const hit = (extra) => ({ trait: "breast carcinoma", rsid: "rs1", p_value: 1e-20, ...extra });
  const first = (h) => rankAssociations([h]).conditions[0];

  it("carries the frequency through", () => {
    expect(first(hit({ risk_frequency: 0.42 })).riskFrequency).toBeCloseTo(0.42);
  });

  it("is null when the study did not report one, rather than zero", () => {
    // Zero would render as "0%", which is a claim the data does not make.
    expect(first(hit({})).riskFrequency).toBeNull();
    expect(first(hit({ risk_frequency: null })).riskFrequency).toBeNull();
  });

  it("keeps a genuine zero distinct from absent", () => {
    expect(first(hit({ risk_frequency: 0 })).riskFrequency).toBe(0);
  });
});
