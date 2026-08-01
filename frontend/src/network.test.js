import { describe, it, expect } from "vitest";
import { buildNetwork, frequencyWeight, evidenceRank, evidenceColor } from "./network";

/* Shaped like a real BRCA1 payload: one curated disease, two uncurated, and a
   phenotype that several of them share — which is the finding the whole view
   exists to surface. */
const NETWORK = {
  gene: "BRCA1",
  diseases: [
    {
      mondo_id: "MONDO:0054748", name: "Fanconi anemia, complementation group S",
      classification: "Definitive", inheritance: "AR", phenotype_total: 32, gene_total: 22,
      phenotypes: [
        { id: "HP:0001873", name: "Thrombocytopenia", category: "Blood", frequency: "Very frequent" },
        { id: "HP:0000957", name: "Cafe-au-lait spot", category: "Skin", frequency: "Frequent" },
        { id: "HP:0002664", name: "Neoplasm", category: "Neoplasm", frequency: "Occasional" },
      ],
    },
    {
      mondo_id: "MONDO:0003582", name: "Hereditary breast and/or ovarian cancer syndrome",
      classification: null, inheritance: null, phenotype_total: 7, gene_total: 15,
      phenotypes: [
        { id: "HP:0002664", name: "Neoplasm", category: "Neoplasm", frequency: "Very frequent" },
        { id: "HP:0012125", name: "Prostate cancer", category: "Neoplasm", frequency: "Occasional" },
      ],
    },
    {
      mondo_id: "MONDO:0015686", name: "Primary peritoneal carcinoma",
      classification: null, inheritance: null, phenotype_total: 6, gene_total: 0,
      phenotypes: [
        { id: "HP:0002664", name: "Neoplasm", category: "Neoplasm", frequency: "Frequent" },
      ],
    },
  ],
};

describe("buildNetwork", () => {
  it("keeps the backend's disease order, which is curated-first", () => {
    const { diseases } = buildNetwork(NETWORK);
    expect(diseases[0].classification).toBe("Definitive");
    expect(diseases[0].name).toMatch(/Fanconi/);
  });

  it("merges a phenotype seen under several diseases into one node", () => {
    /* Neoplasm appears under all three. Three separate nodes would hide the
       one thing worth noticing. */
    const { phenotypes } = buildNetwork(NETWORK);
    const neoplasm = phenotypes.filter(p => p.key === "HP:0002664");
    expect(neoplasm).toHaveLength(1);
    expect(neoplasm[0].diseaseIndexes).toEqual([0, 1, 2]);
  });

  it("marks and hoists phenotypes that several diseases share", () => {
    const { phenotypes, shared } = buildNetwork(NETWORK);
    expect(phenotypes[0].key).toBe("HP:0002664");
    expect(phenotypes[0].shared).toBe(true);
    expect(shared).toBe(1);
  });

  it("does not mark a phenotype seen under only one disease", () => {
    const { phenotypes } = buildNetwork(NETWORK);
    expect(phenotypes.find(p => p.key === "HP:0001873").shared).toBe(false);
  });

  it("keeps the strongest frequency any disease asserts", () => {
    /* Neoplasm is Occasional in one disease and Very frequent in another.
       Reporting the weaker claim would understate it. */
    const { phenotypes } = buildNetwork(NETWORK);
    expect(phenotypes.find(p => p.key === "HP:0002664").bestFrequency).toBe("Very frequent");
  });

  it("emits one link per disease mentioning a phenotype", () => {
    const { links } = buildNetwork(NETWORK);
    expect(links.filter(l => l.phenotype === 0)).toHaveLength(3);
    expect(links).toHaveLength(6);
  });

  it("links point at real nodes", () => {
    const { diseases, phenotypes, links } = buildNetwork(NETWORK);
    for (const l of links) {
      expect(diseases[l.disease]).toBeDefined();
      expect(phenotypes[l.phenotype]).toBeDefined();
    }
  });

  it("drops the least informative phenotypes first when space runs out", () => {
    const { phenotypes, hidden } = buildNetwork(NETWORK, { maxPhenotypes: 2 });
    expect(phenotypes).toHaveLength(2);
    expect(phenotypes[0].shared).toBe(true);
    expect(hidden).toBe(2);
  });

  it("reports nothing hidden when everything fits", () => {
    expect(buildNetwork(NETWORK).hidden).toBe(0);
  });

  it("survives a disease with no phenotypes", () => {
    const sparse = { diseases: [{ name: "Something", phenotypes: [] }] };
    const built = buildNetwork(sparse);
    expect(built.diseases).toHaveLength(1);
    expect(built.phenotypes).toEqual([]);
    expect(built.links).toEqual([]);
  });

  it("is safe on nothing at all", () => {
    expect(buildNetwork(null).diseases).toEqual([]);
    expect(buildNetwork({ diseases: [] }).links).toEqual([]);
  });
});

describe("frequencyWeight", () => {
  it("weighs an obligate phenotype above an occasional one", () => {
    expect(frequencyWeight("Obligate")).toBeGreaterThan(frequencyWeight("Occasional"));
    expect(frequencyWeight("Very frequent")).toBeGreaterThan(frequencyWeight("Very rare"));
  });

  it("gives an unstated frequency a middling weight rather than zero", () => {
    /* Unknown is not the same as never, and drawing it invisible would assert
       something the data does not. */
    const unknown = frequencyWeight(null);
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeLessThan(frequencyWeight("Frequent"));
  });
});

describe("evidence", () => {
  it("ranks definitive above limited", () => {
    expect(evidenceRank("Definitive")).toBeLessThan(evidenceRank("Limited"));
  });

  it("sorts an uncurated link last without treating it as refuted", () => {
    expect(evidenceRank(null)).toBeGreaterThan(evidenceRank("Refuted"));
  });

  it("colours definitive and disputed differently", () => {
    expect(evidenceColor("Definitive")).not.toBe(evidenceColor("Disputed"));
    expect(evidenceColor(null)).toBe(evidenceColor("anything unrecognised"));
  });
});
