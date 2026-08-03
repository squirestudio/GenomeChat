import { describe, it, expect } from "vitest";
import { COMPLEMENT, alleles, zygosity, buildHelix, rungEnds, helixCoverage } from "./helix";

const LOCUS = { chromosome: "17", start: 41196312, end: 41277500 };  // BRCA1, GRCh37
const hit = (pos, genotype, rsid = "rs1") => ({ rsid, position: pos, genotype });

describe("base pairing", () => {
  it("only pairs the way DNA actually pairs", () => {
    expect(COMPLEMENT).toEqual({ A: "T", T: "A", G: "C", C: "G" });
  });
});

describe("alleles", () => {
  it("splits a two-base genotype", () => {
    expect(alleles("AG")).toEqual(["A", "G"]);
    expect(alleles("a/g")).toEqual(["A", "G"]);
  });

  it("treats a single base as one copy, not two", () => {
    // 23andMe reports one base on Y and for mitochondrial positions because
    // there genuinely is only one copy. Expanding "A" to "AA" would claim a
    // second copy that does not exist.
    expect(alleles("A")).toEqual(["A", null]);
    expect(zygosity("A")).toBe("hemizygous");
  });

  it("rejects indels and no-calls, which are not base pairs", () => {
    for (const g of ["--", "II", "DD", "", null]) expect(alleles(g)).toEqual([]);
    expect(zygosity("--")).toBeNull();
  });
});

describe("zygosity", () => {
  it("names the case worth surfacing", () => {
    expect(zygosity("AG")).toBe("heterozygous");
    expect(zygosity("AA")).toBe("homozygous");
  });
});

describe("buildHelix", () => {
  it("draws a true complementary pair, never the genotype as a rung", () => {
    // The correctness point: a rung is A opposite T. "A—G" would teach
    // something false, so heterozygosity is marked instead of drawn.
    const { rungs } = buildHelix([hit(41200000, "AG")], LOCUS);
    expect(rungs[0].base).toBe("A");
    expect(rungs[0].pair).toBe("T");
    expect(rungs[0].zygosity).toBe("heterozygous");
    expect(rungs[0].genotype).toBe("AG");
  });

  it("positions rungs by real coordinate, so gaps are literal", () => {
    const { rungs } = buildHelix([hit(41196312, "AA"), hit(41277500, "GG")], LOCUS);
    expect(rungs[0].at).toBeCloseTo(0, 5);
    expect(rungs[1].at).toBeCloseTo(1, 5);
  });

  it("sorts along the gene regardless of input order", () => {
    const { rungs } = buildHelix([hit(41250000, "CC"), hit(41200000, "AA")], LOCUS);
    expect(rungs.map(r => r.position)).toEqual([41200000, 41250000]);
  });

  it("skips readings outside the gene and reports the count", () => {
    const got = buildHelix([hit(41200000, "AA"), hit(1000, "GG"), hit(41200001, "--")], LOCUS);
    expect(got.kept).toBe(1);
    expect(got.skipped).toBe(2);
  });

  it("thins evenly rather than truncating, so the whole span stays represented", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      hit(41196312 + i * 250, "AA", `rs${i}`));
    const { rungs, kept } = buildHelix(many, LOCUS, { maxRungs: 20 });
    expect(rungs).toHaveLength(20);
    expect(kept).toBe(300);
    expect(rungs.at(-1).at).toBeGreaterThan(0.9);   // the far end survived
  });

  it("is safe without a locus", () => {
    expect(buildHelix([hit(1, "AA")], null).rungs).toEqual([]);
    expect(buildHelix(null, LOCUS).rungs).toEqual([]);
  });
});

describe("rungEnds", () => {
  it("puts the two ends on opposite sides of the axis", () => {
    const { y1, y2 } = rungEnds(0.25, 400, 80, 3);
    expect(Math.sign(y1 - 40)).toBe(-Math.sign(y2 - 40));
  });

  it("reports depth so rungs at the crossings can be drawn behind", () => {
    // Where the strands cross, a rung is edge-on and should recede.
    expect(rungEnds(0, 400, 80, 3).depth).toBeCloseTo(0, 5);
  });
});

describe("helixCoverage", () => {
  it("says how sparse the reading really is", () => {
    // BRCA1 is ~81kb; eleven readings is one base in about 7,400.
    expect(helixCoverage(11, 81188)).toBe(7381);
  });

  it("is null rather than Infinity with nothing read", () => {
    expect(helixCoverage(0, 81188)).toBeNull();
  });
});
