import { describe, it, expect } from "vitest";
import { pictogramScale, sharedPictogramScale, filledOn, fillOn, oneInPhrase, comparePopulations } from "./frequency";

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

describe("sharedPictogramScale", () => {
  /* The flaw a reader spotted: scaling each group independently made the most
     and least affected CFTR groups both resolve to one filled dot, hiding the
     2x difference the panel exists to show. */
  const CFTR = [0.000558, 0.000469, 0.000422, 0.000399, 0.000359, 0.000333, 0.000279];

  it("picks one grid fine enough for the rarest group to register", () => {
    const s = sharedPictogramScale(CFTR);
    expect(s.total).toBe(10000);
    expect(filledOn(Math.min(...CFTR), s.total)).toBeGreaterThanOrEqual(1);
  });

  it("makes the difference between groups visible", () => {
    const { total } = sharedPictogramScale(CFTR);
    const most = filledOn(0.000558, total);
    const least = filledOn(0.000279, total);
    expect(most).toBe(6);
    expect(least).toBe(3);
    expect(most).toBeGreaterThan(least);   // the whole point
  });

  it("uses a coarser grid when the variant is common enough not to need one", () => {
    expect(sharedPictogramScale([0.16, 0.09]).total).toBe(100);
  });

  it("never renders a present group as an empty grid", () => {
    /* Zero dots reads as "not found here", which is a different claim. */
    const { total } = sharedPictogramScale([0.5, 0.00002]);
    expect(filledOn(0.00002, total)).toBeGreaterThanOrEqual(1);
  });

  it("is safe on nothing", () => {
    expect(sharedPictogramScale([])).toBeNull();
    expect(sharedPictogramScale(null)).toBeNull();
    expect(filledOn(null, 1000)).toBe(0);
  });
});

describe("a grid has to separate the groups, not just show them", () => {
  // The bug this fixes: for a gene whose ancestry groups run from 1 in 720 to
  // 1 in 1,000, every group rounded to exactly one dot on the thousand-grid.
  // Seven identical pictures for seven different numbers, directly above a bar
  // chart that showed the differences perfectly well.
  const NARROW = [1 / 720, 1 / 750, 1 / 790, 1 / 910, 1 / 950, 1 / 960, 1 / 1000];

  it("picks a grid fine enough that the rarest group is countable", () => {
    expect(sharedPictogramScale(NARROW).total).toBe(10000);
  });

  it("gives visibly different whole-dot counts across the range", () => {
    const { total } = sharedPictogramScale(NARROW);
    const counts = NARROW.map(f => fillOn(f, total).whole);
    expect(Math.max(...counts) - Math.min(...counts)).toBeGreaterThanOrEqual(3);
  });

  it("still uses a small grid for a common variant", () => {
    expect(sharedPictogramScale([0.3, 0.25, 0.2]).total).toBe(100);
  });

  it("falls back to the finest grid when nothing can separate them", () => {
    expect(sharedPictogramScale([1 / 50000, 1 / 80000]).total).toBe(10000);
  });
});

describe("fillOn", () => {
  it("returns whole dots and the remainder separately", () => {
    const f = fillOn(1 / 720, 10000);
    expect(f.whole).toBe(13);
    expect(f.partial).toBeCloseTo(0.888, 2);
  });

  it("distinguishes frequencies that share a whole-dot count", () => {
    // 1 in 950 and 1 in 960 are both ten whole dots. The remainder is the only
    // thing telling them apart, which is the whole reason it exists.
    const a = fillOn(1 / 950, 10000);
    const b = fillOn(1 / 960, 10000);
    expect(a.whole).toBe(b.whole);
    expect(a.partial).not.toBeCloseTo(b.partial, 2);
  });

  it("does not round a sliver up to a whole person", () => {
    // filledOn had Math.max(1, ...), drawing a full dot for two tenths of one —
    // overstating rarity in the panel meant to convey it.
    const f = fillOn(0.00002, 10000);
    expect(f.whole).toBe(0);
    expect(f.partial).toBeGreaterThan(0);
    expect(f.partial).toBeLessThan(1);
  });

  it("keeps a very rare group visible rather than drawing an empty grid", () => {
    expect(fillOn(1e-9, 10000).partial).toBeGreaterThanOrEqual(0.18);
  });

  it("has no remainder when the grid is completely filled", () => {
    expect(fillOn(1, 100)).toMatchObject({ whole: 100, partial: 0 });
  });

  it("is safe on nothing", () => {
    expect(fillOn(0, 1000)).toMatchObject({ whole: 0, partial: 0 });
    expect(fillOn(null, 1000).exact).toBe(0);
    expect(fillOn(0.5, 0).exact).toBe(0);
  });
});
