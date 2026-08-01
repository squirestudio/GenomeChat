import { describe, it, expect } from "vitest";
import { pictogramScale, oneInPhrase, comparePopulations } from "./frequency";

describe("pictogramScale", () => {
  it("scales the grid to the rarity rather than fixing it", () => {
    /* A hundred dots cannot represent one in 833 — the whole reason the old
       bar chart failed is that it had one fixed scale. */
    expect(pictogramScale(0.0012).total).toBe(1000);
    expect(pictogramScale(0.16).total).toBe(100);
    expect(pictogramScale(0.0002).total).toBe(10000);
  });

  it("always fills at least one dot when the variant exists at all", () => {
    for (const f of [0.5, 0.16, 0.01, 0.0012, 0.0002, 0.0001]) {
      const s = pictogramScale(f);
      expect(s.filled).toBeGreaterThanOrEqual(1);
    }
  });

  it("fills a countable number, not a smear", () => {
    const s = pictogramScale(0.16);
    expect(s.filled).toBe(16);
    expect(s.filled).toBeLessThan(s.total);
  });

  it("gives up rather than rounding someone's variant out of existence", () => {
    /* Below one in ten thousand no honest grid works. Returning null lets the
       component fall back to the phrase, which is still true. */
    expect(pictogramScale(0.000004)).toBeNull();
  });

  it("handles a variant nearly everyone carries", () => {
    expect(pictogramScale(1).filled).toBe(100);
  });

  it("is safe on absent or impossible values", () => {
    expect(pictogramScale(0)).toBeNull();
    expect(pictogramScale(null)).toBeNull();
    expect(pictogramScale(-1)).toBeNull();
    expect(pictogramScale("nonsense")).toBeNull();
  });
});

describe("oneInPhrase", () => {
  it("says the thing a person can repeat", () => {
    expect(oneInPhrase(0.0012)).toBe("1 in 830");   // 1/0.0012 = 833
    expect(oneInPhrase(0.01)).toBe("1 in 100");
  });

  it("rounds to something speakable rather than exact", () => {
    /* "1 in 832.6" is a decimal wearing a fact's clothes. */
    expect(oneInPhrase(0.0012013)).not.toMatch(/\./);
    expect(oneInPhrase(0.00437)).toBe("1 in 230");
  });

  it("switches phrasing when a variant is common", () => {
    expect(oneInPhrase(0.6)).toBe("60 in 100");
  });

  it("is safe on absent values", () => {
    expect(oneInPhrase(0)).toBeNull();
    expect(oneInPhrase(null)).toBeNull();
  });
});

describe("comparePopulations", () => {
  const POPS = [
    { population_id: "sas", population: "South Asian", allele_frequency: 0.0012175, allele_count: 655322, allele_number: 538253796 },
    { population_id: "fin", population: "Finnish", allele_frequency: 0.00097996, allele_count: 314528, allele_number: 320958402 },
    { population_id: "mid", population: "Middle Eastern", allele_frequency: 0.00092183 },
    { population_id: "zero", population: "Nowhere", allele_frequency: 0 },
  ];

  it("orders by frequency, most affected first", () => {
    expect(comparePopulations(POPS).rows.map(r => r.id)).toEqual(["sas", "fin", "mid"]);
  });

  it("expresses each as a share of the highest, which is what a bar can honestly show", () => {
    const { rows } = comparePopulations(POPS);
    expect(rows[0].relative).toBe(1);
    expect(rows[1].relative).toBeCloseTo(0.805, 2);
  });

  it("drops populations where the variant was never seen", () => {
    /* Zero is a real observation but an unplottable one, and a zero-length bar
       reads as missing data rather than as absence. */
    expect(comparePopulations(POPS).rows.find(r => r.id === "zero")).toBeUndefined();
  });

  it("carries the readable phrase through for each population", () => {
    expect(comparePopulations(POPS).rows[0].phrase).toBe("1 in 820");  // 1/0.0012175
  });

  it("reports a spread only when it is large enough to mean something", () => {
    const narrow = comparePopulations([
      { population: "A", allele_frequency: 0.001 },
      { population: "B", allele_frequency: 0.0009 },
    ]);
    expect(narrow.spread).toBeNull();

    const wide = comparePopulations([
      { population: "A", allele_frequency: 0.01 },
      { population: "B", allele_frequency: 0.001 },
    ]);
    expect(wide.spread).toBe(10);
  });

  it("is safe on nothing", () => {
    expect(comparePopulations([]).rows).toEqual([]);
    expect(comparePopulations(null).rows).toEqual([]);
  });
});
