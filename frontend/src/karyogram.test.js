import { describe, it, expect } from "vitest";
import {
  CHROMOSOMES, GENOME_LENGTH, normaliseChrom, binVariants,
  coverageFraction, coveragePhrase, locusBin,
} from "./karyogram";

const dna = (rows) => ({
  variants: new Map(rows.map((r, i) => [`rs${i}`, r])),
});

describe("chromosome reference data", () => {
  it("covers all 24 chromosomes", () => {
    expect(CHROMOSOMES).toHaveLength(24);
    expect(CHROMOSOMES.at(-1).name).toBe("Y");
  });

  it("is GRCh37, which is what consumer files report", () => {
    // chr1 is 249,250,621 on GRCh37 and 248,956,422 on GRCh38. Mixing builds
    // would put every mark megabases out — see the genome-build note in CLAUDE.md.
    expect(CHROMOSOMES[0].length).toBe(249250621);
  });

  it("sums to roughly a haploid genome", () => {
    expect(GENOME_LENGTH).toBeGreaterThan(3.0e9);
    expect(GENOME_LENGTH).toBeLessThan(3.2e9);
  });
});

describe("normaliseChrom", () => {
  it("accepts the many ways a file writes a chromosome", () => {
    expect(normaliseChrom("chr7")).toBe("7");
    expect(normaliseChrom(" 7 ")).toBe("7");
    expect(normaliseChrom("chrX")).toBe("X");
  });

  it("maps the numeric aliases 23andMe uses", () => {
    expect(normaliseChrom("23")).toBe("X");
    expect(normaliseChrom("24")).toBe("Y");
    expect(normaliseChrom("26")).toBe("MT");
  });

  it("treats the pseudoautosomal region as X rather than dropping it", () => {
    expect(normaliseChrom("XY")).toBe("X");
    expect(normaliseChrom("25")).toBe("X");
  });

  it("is safe on nothing", () => {
    expect(normaliseChrom(null)).toBe("");
    expect(normaliseChrom(undefined)).toBe("");
  });
});

describe("binVariants", () => {
  it("places a variant in the right bin", () => {
    const { bins } = binVariants(dna([{ chromosome: "1", position: 3_000_000 }]), 2_000_000);
    expect(bins.get("1")[1]).toBe(1);   // 3 Mb falls in the second 2 Mb bin
  });

  it("counts mitochondrial calls separately rather than discarding them", () => {
    // They are real data and not on any nuclear chromosome. Dropping them
    // silently would make the totals disagree with the reader's file.
    const got = binVariants(dna([
      { chromosome: "MT", position: 100 },
      { chromosome: "1", position: 500 },
    ]));
    expect(got.mitochondrial).toBe(1);
    expect(got.placed).toBe(1);
  });

  it("reports unplaceable rows instead of losing them", () => {
    const got = binVariants(dna([
      { chromosome: "99", position: 1 },
      { chromosome: "1", position: "not a number" },
    ]));
    expect(got.unplaced).toBe(2);
    expect(got.placed).toBe(0);
  });

  it("clamps a position past the end of a chromosome into the last bin", () => {
    const { bins } = binVariants(dna([{ chromosome: "21", position: 999_000_000 }]));
    const arr = bins.get("21");
    expect(arr[arr.length - 1]).toBe(1);
  });

  it("reports the busiest bin, which sets the density scale", () => {
    const got = binVariants(dna([
      { chromosome: "1", position: 1_000 },
      { chromosome: "1", position: 2_000 },
      { chromosome: "2", position: 1_000 },
    ]), 2_000_000);
    expect(got.busiest).toBe(2);
  });

  it("is safe with no DNA loaded", () => {
    const got = binVariants(null);
    expect(got.placed).toBe(0);
    expect(got.busiest).toBe(0);
    expect(got.bins.size).toBe(24);
  });
});

describe("coverage", () => {
  it("is honest about how little an array reads", () => {
    // The whole reason this view exists: ~900k positions of 3.1 billion bases.
    const f = coverageFraction(900_000);
    expect(f).toBeLessThan(0.0005);
    expect(coveragePhrase(900_000)).toMatch(/1 base in every 3,\d\d\d/);
  });

  it("is zero rather than NaN for an empty file", () => {
    expect(coverageFraction(0)).toBe(0);
    expect(coveragePhrase(0)).toBeNull();
  });
});

describe("locusBin", () => {
  it("finds the bins a gene spans", () => {
    // BRCA1 on GRCh37: chr17:41,196,312-41,277,500
    const got = locusBin({ chromosome: "17", start: 41196312, end: 41277500 }, 2_000_000);
    expect(got.chromosome).toBe("17");
    expect(got.from).toBe(20);
    expect(got.to).toBeGreaterThanOrEqual(got.from);
  });

  it("handles a locus with no end", () => {
    const got = locusBin({ chromosome: "7", start: 5_000_000 }, 2_000_000);
    expect(got.from).toBe(got.to);
  });

  it("is null for a chromosome it does not know", () => {
    expect(locusBin({ chromosome: "99", start: 1 })).toBeNull();
    expect(locusBin(null)).toBeNull();
  });
});
