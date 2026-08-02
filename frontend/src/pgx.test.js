import { describe, it, expect } from "vitest";
import { normalizeGenotype, readerGenotypeFor, matchedAllelePhenotype, countMatches } from "./pgx";

// A real ClinPGx annotation, trimmed: rs7412 in APOE, atorvastatin response.
const RS7412 = {
  level: "2B",
  variant: "rs7412",
  rsids: ["rs7412"],
  drugs: ["atorvastatin"],
  allele_phenotypes: [
    { allele: "CC", phenotype: "Patients with the rs7412 CC genotype may have decreased response to atorvastatin.", limited_evidence: false },
    { allele: "CT", phenotype: "Patients with the rs7412 CT genotype may have increased response to atorvastatin.", limited_evidence: false },
    { allele: "TT", phenotype: "Patients with the rs7412 TT genotype may have increased response to atorvastatin.", limited_evidence: true },
  ],
};

// Star alleles describe haplotypes a genotyping array cannot resolve.
const STAR = {
  level: "1A",
  variant: "SLCO1B1*1, SLCO1B1*5",
  rsids: [],
  allele_phenotypes: [{ allele: "*5", phenotype: "No function allele.", limited_evidence: false }],
};

const dna = (entries) => ({ variants: new Map(Object.entries(entries)) });

describe("normalizeGenotype", () => {
  it("treats a genotype as unordered, because files disagree on order", () => {
    expect(normalizeGenotype("TC")).toBe(normalizeGenotype("CT"));
  });

  it("ignores case and separators", () => {
    expect(normalizeGenotype("c/t")).toBe("CT");
  });

  it("is empty for a no-call", () => {
    expect(normalizeGenotype("--")).toBe("");
    expect(normalizeGenotype("")).toBe("");
    expect(normalizeGenotype(null)).toBe("");
  });
});

describe("readerGenotypeFor", () => {
  it("finds the reader's genotype at the annotated rsID", () => {
    expect(readerGenotypeFor(RS7412, dna({ rs7412: { genotype: "CT" } })))
      .toEqual({ rsid: "rs7412", genotype: "CT" });
  });

  it("treats a no-call as absent rather than as a genotype", () => {
    // Reporting a finding from a position the array failed to read would be
    // inventing one.
    expect(readerGenotypeFor(RS7412, dna({ rs7412: { genotype: "--" } }))).toBeNull();
  });

  it("returns null when the file does not cover the position", () => {
    // Normal: consumer arrays genotype a small fraction of the genome.
    expect(readerGenotypeFor(RS7412, dna({ rs1234: { genotype: "AA" } }))).toBeNull();
  });

  it("never matches a star-allele annotation", () => {
    expect(readerGenotypeFor(STAR, dna({ rs4149056: { genotype: "CC" } }))).toBeNull();
  });

  it("is safe with no DNA loaded", () => {
    expect(readerGenotypeFor(RS7412, null)).toBeNull();
    expect(readerGenotypeFor(null, dna({}))).toBeNull();
  });
});

describe("matchedAllelePhenotype", () => {
  it("returns the interpretation for the genotype the reader carries", () => {
    const m = matchedAllelePhenotype(RS7412, dna({ rs7412: { genotype: "CT" } }));
    expect(m.genotype).toBe("CT");
    expect(m.phenotype).toContain("increased response");
  });

  it("matches regardless of allele order in the file", () => {
    const m = matchedAllelePhenotype(RS7412, dna({ rs7412: { genotype: "TC" } }));
    expect(m.phenotype).toContain("increased response");
  });

  it("carries the limited-evidence flag through", () => {
    expect(matchedAllelePhenotype(RS7412, dna({ rs7412: { genotype: "TT" } })).limited_evidence).toBe(true);
  });

  it("returns null for a genotype the annotation does not cover", () => {
    // Guessing a nearest match would be exactly the overreach the rest of the
    // app refuses.
    expect(matchedAllelePhenotype(RS7412, dna({ rs7412: { genotype: "AA" } }))).toBeNull();
  });

  it("is safe on nothing", () => {
    expect(matchedAllelePhenotype({}, dna({}))).toBeNull();
    expect(matchedAllelePhenotype(RS7412, null)).toBeNull();
  });
});

describe("countMatches", () => {
  it("counts only the annotations this reader's file speaks to", () => {
    expect(countMatches([RS7412, STAR], dna({ rs7412: { genotype: "CC" } }))).toBe(1);
  });

  it("is zero with no DNA loaded, so the panel promises nothing", () => {
    expect(countMatches([RS7412], null)).toBe(0);
    expect(countMatches(null, dna({}))).toBe(0);
  });
});
