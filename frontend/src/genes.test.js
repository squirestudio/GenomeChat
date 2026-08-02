import { describe, it, expect } from "vitest";
import { genesInData, looksLikeGene, isGene, linkifyGenes } from "./genes";

describe("genesInData", () => {
  it("finds the gene an answer is about", () => {
    expect(genesInData({ gene_info: { symbol: "BRCA1" } }).has("BRCA1")).toBe(true);
  });

  it("finds genes from a disease answer", () => {
    const data = { genes: [{ gene_symbol: "SOD1" }, { gene_symbol: "MEF2C" }] };
    expect([...genesInData(data)].sort()).toEqual(["MEF2C", "SOD1"]);
  });

  it("finds interaction partners, which are stored under a third key", () => {
    expect(genesInData({ interactions: [{ gene: "PALB2" }] }).has("PALB2")).toBe(true);
  });

  it("reaches genes nested anywhere in the response", () => {
    const deep = { disease_network: { related: [{ symbol: "TMEM38B" }] } };
    expect(genesInData(deep).has("TMEM38B")).toBe(true);
  });

  it("ignores values under those keys that are not symbol-shaped", () => {
    const data = { clingen: [{ gene: "not a symbol" }, { gene: "ATM" }] };
    expect([...genesInData(data)]).toEqual(["ATM"]);
  });

  it("is safe on nothing", () => {
    expect(genesInData(null).size).toBe(0);
    expect(genesInData({}).size).toBe(0);
  });
});

describe("looksLikeGene", () => {
  it("accepts symbols with a digit", () => {
    for (const g of ["BRCA1", "TP53", "COL1A1", "WNT1", "TMEM38B", "SOD1", "MEF2C"]) {
      expect(looksLikeGene(g), g).toBe(true);
    }
  });

  it("accepts four-letter symbols without a digit", () => {
    for (const g of ["APOE", "PURA", "SETX", "OPA1"]) expect(looksLikeGene(g), g).toBe(true);
  });

  it("rejects disease abbreviations, which are shaped exactly like symbols", () => {
    // The reason this rule exists: "OI" would otherwise be offered as a gene
    // query on every osteogenesis imperfecta answer.
    for (const x of ["OI", "MS", "CF", "HD", "MI", "SMA", "ALS"]) {
      expect(looksLikeGene(x), x).toBe(false);
    }
  });

  it("rejects data jargon and ancestry labels", () => {
    for (const x of ["DNA", "SNP", "GWAS", "PMID", "NFE", "EAS", "AF", "OMIM"]) {
      expect(looksLikeGene(x), x).toBe(false);
    }
  });

  it("rejects short symbols with no digit, which are too ambiguous to guess", () => {
    // ATM is a real gene, and stays clickable via the data-backed tier — see
    // isGene. It is only shape-alone detection that declines it.
    expect(looksLikeGene("ATM")).toBe(false);
  });
});

describe("isGene", () => {
  it("trusts the data over the shape rule", () => {
    expect(isGene("ATM", new Set(["ATM"]))).toBe(true);
    expect(isGene("ATM", new Set())).toBe(false);
  });

  it("still refuses a stoplisted token the shape rule would reject", () => {
    expect(isGene("OI", new Set())).toBe(false);
  });

  it("accepts a data-backed symbol even if it is stoplisted elsewhere", () => {
    // DMD is both a gene and Duchenne muscular dystrophy. When the pipeline
    // returned it, it is the gene.
    expect(isGene("DMD", new Set(["DMD"]))).toBe(true);
  });

  it("is safe on nothing", () => {
    expect(isGene("", new Set())).toBe(false);
    expect(isGene(null, null)).toBe(false);
  });
});

describe("linkifyGenes", () => {
  const known = new Set(["ATM", "TMEM38B"]);

  it("marks genes and leaves the rest as text", () => {
    const parts = linkifyGenes("Variants in TMEM38B disrupt collagen.", known);
    expect(parts).toEqual(["Variants in ", { gene: "TMEM38B" }, " disrupt collagen."]);
  });

  it("marks several in one sentence", () => {
    const parts = linkifyGenes("COL1A1, COL1A2, WNT1 and TMEM38B", known);
    expect(parts.filter(p => p.gene).map(p => p.gene))
      .toEqual(["COL1A1", "COL1A2", "WNT1", "TMEM38B"]);
  });

  it("leaves a condition abbreviation alone", () => {
    expect(linkifyGenes("patients with OI", known)).toEqual(["patients with OI"]);
  });

  it("does not match a symbol embedded in a word, or an rsID", () => {
    expect(linkifyGenes("theBRCA1gene and rs12345", known)).toEqual(["theBRCA1gene and rs12345"]);
  });

  it("does match across a hyphen, which is where symbols really appear", () => {
    const parts = linkifyGenes("BRCA1-related cancers", known);
    expect(parts[0]).toEqual({ gene: "BRCA1" });
  });

  it("returns the original text when nothing matches", () => {
    expect(linkifyGenes("no genes here at all", known)).toEqual(["no genes here at all"]);
  });

  it("is safe on nothing", () => {
    expect(linkifyGenes("", known)).toEqual([]);
    expect(linkifyGenes(null, known)).toEqual([]);
  });
});
