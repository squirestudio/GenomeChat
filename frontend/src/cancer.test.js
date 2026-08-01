import { describe, it, expect } from "vitest";
import { rankCancerTypes, splitConsequences, isBroad } from "./cancer";

/* Real TP53 output from the GDC fetcher. */
const TP53 = [
  { project_id: "CPTAC-3", cancer_type: "CPTAC-3 (multi-cancer proteogenomics)", mutation_count: 685 },
  { project_id: "ALCHEMIST-ALCH", cancer_type: "ALCHEMIST (early-stage lung)", mutation_count: 603 },
  { project_id: "TCGA-LUSC", cancer_type: "Lung Squamous Cell", mutation_count: 432 },
  { project_id: "TCGA-HNSC", cancer_type: "Head & Neck Cancer", mutation_count: 426 },
  { project_id: "TCGA-OV", cancer_type: "Ovarian Cancer", mutation_count: 372 },
  { project_id: "TCGA-BRCA", cancer_type: "Breast Cancer", mutation_count: 336 },
  { project_id: "TCGA-UCS", cancer_type: "Uterine Carcinosarcoma", mutation_count: 0 },
];

describe("rankCancerTypes", () => {
  it("orders by mutation count", () => {
    const { rows } = rankCancerTypes(TP53);
    expect(rows[0].projectId).toBe("CPTAC-3");
    expect(rows.map(r => r.count)).toEqual([...rows.map(r => r.count)].sort((a, b) => b - a));
  });

  it("marks a multi-cancer cohort as not being a cancer type", () => {
    /* CPTAC-3 tops the list for both TP53 and BRCA1. Presenting it as the
       cancer this gene is most mutated in would be a statement about cohort
       size, not biology. */
    const { rows } = rankCancerTypes(TP53);
    expect(rows.find(r => r.projectId === "CPTAC-3").broad).toBe(true);
    expect(rows.find(r => r.projectId === "TCGA-LUSC").broad).toBe(false);
  });

  it("keeps broad cohorts in the ranking rather than hiding them", () => {
    /* Removing them would misstate the totals; the fix is labelling. */
    expect(rankCancerTypes(TP53).rows.some(r => r.broad)).toBe(true);
  });

  it("tracks the largest disease-specific project separately", () => {
    /* So one big multi-cancer cohort cannot flatten every real cancer type
       against the axis. */
    const { max, specificMax } = rankCancerTypes(TP53);
    expect(max).toBe(685);            // CPTAC-3
    expect(specificMax).toBe(603);    // ALCHEMIST, the largest specific one
  });

  it("drops projects with no mutations", () => {
    expect(rankCancerTypes(TP53).rows.find(r => r.projectId === "TCGA-UCS")).toBeUndefined();
  });

  it("expresses each as a share of the largest", () => {
    const { rows } = rankCancerTypes(TP53);
    expect(rows[0].relative).toBe(1);
    expect(rows[2].relative).toBeCloseTo(432 / 685, 3);
  });

  it("reports what it left out", () => {
    const { rows, hidden } = rankCancerTypes(TP53, { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(hidden).toBe(3);
  });

  it("is safe on nothing", () => {
    expect(rankCancerTypes([]).rows).toEqual([]);
    expect(rankCancerTypes(null).rows).toEqual([]);
  });
});

describe("splitConsequences", () => {
  /* TP53's real output. Note the top three sum to more than the gene's 6,255
     total mutations — these are annotations against every transcript a
     mutation touches, not mutation counts. */
  const CONSEQUENCES = [
    { type: "Upstream Gene", count: 5806 },
    { type: "Downstream Gene", count: 5487 },
    { type: "Missense", count: 3930 },
    { type: "Intron", count: 3569 },
    { type: "Nonsense", count: 412 },
    { type: "Frameshift", count: 288 },
  ];

  it("separates the consequences that change the protein", () => {
    const { coding } = splitConsequences(CONSEQUENCES);
    expect(coding.map(c => c.type)).toEqual(["Missense", "Nonsense", "Frameshift"]);
  });

  it("keeps the non-coding annotations rather than discarding them", () => {
    const { other } = splitConsequences(CONSEQUENCES);
    expect(other.map(c => c.type)).toContain("Upstream Gene");
    expect(other.map(c => c.type)).toContain("Intron");
  });

  it("does not let a non-coding annotation lead", () => {
    /* "Upstream Gene: 5,806" as a gene's headline consequence is true and
       useless — it counts annotations against neighbouring transcripts. */
    expect(splitConsequences(CONSEQUENCES).coding[0].type).toBe("Missense");
  });

  it("shares are of the coding total, not of everything", () => {
    const { coding, codingTotal } = splitConsequences(CONSEQUENCES);
    expect(codingTotal).toBe(3930 + 412 + 288);
    expect(coding[0].share).toBeCloseTo(3930 / codingTotal, 3);
    expect(coding.reduce((n, c) => n + c.share, 0)).toBeCloseTo(1, 5);
  });

  it("is safe on nothing", () => {
    expect(splitConsequences([]).coding).toEqual([]);
    expect(splitConsequences(null).other).toEqual([]);
  });
});

describe("isBroad", () => {
  it("knows the multi-cancer cohorts", () => {
    expect(isBroad("CPTAC-3")).toBe(true);
    expect(isBroad("cptac-3")).toBe(true);
  });

  it("treats a disease-specific project as specific", () => {
    expect(isBroad("TCGA-BRCA")).toBe(false);
    expect(isBroad("MMRF-COMMPASS")).toBe(false);
    expect(isBroad(null)).toBe(false);
  });
});
