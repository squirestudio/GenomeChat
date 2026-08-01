import { describe, it, expect } from "vitest";
import { parseDNAFile } from "./dna";
import {
  residueSeverity, variantColorBands,
  consequenceClass, significanceClass, evidenceLevel,
  fullView, clampView, zoomView, panView, isFullView, MIN_SPAN,
  positionVariants, filterVariants, facetCounts,
  assignLanes, domainAt, prepareDomains, matchUserGenotypes,
} from "./lollipop";

/**
 * The encodings and geometry behind the variant map. All of it is arithmetic
 * that can be checked, which is why it lives outside the SVG — a lane packer
 * that quietly drops variants draws a map that is wrong rather than one that
 * looks broken.
 */

describe("consequenceClass", () => {
  it("reads ClinVar's vocabulary", () => {
    expect(consequenceClass("nonsense").key).toBe("truncating");
    expect(consequenceClass("frameshift variant").key).toBe("truncating");
    expect(consequenceClass("missense variant").key).toBe("missense");
    expect(consequenceClass("inframe deletion").key).toBe("inframe");
    expect(consequenceClass("synonymous variant").key).toBe("silent");
  });

  it("treats a splice variant as splice even though it also frameshifts", () => {
    /* Order matters in the match list: a splice variant frequently carries a
       frameshift term too, and calling it truncating loses what is distinctive
       about it. */
    expect(consequenceClass("splice donor variant").key).toBe("splice");
    expect(consequenceClass("splice acceptor variant").key).toBe("splice");
  });

  it("gives every class a distinct glyph so shape is readable", () => {
    const keys = ["truncating", "splice", "missense", "inframe", "silent", "noncoding"];
    const glyphs = keys.map(k => {
      const sample = { truncating: "nonsense", splice: "splice donor variant",
        missense: "missense variant", inframe: "inframe deletion",
        silent: "synonymous variant", noncoding: "intron variant" }[k];
      return consequenceClass(sample).glyph;
    });
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("falls back rather than throwing on something unrecognised", () => {
    expect(consequenceClass(null).key).toBe("other");
    expect(consequenceClass("").key).toBe("other");
    expect(consequenceClass("some new term nobody has seen").key).toBe("other");
  });
});

describe("significanceClass", () => {
  it("separates pathogenic from likely pathogenic", () => {
    /* These are different clinical calls and must not share a colour. */
    expect(significanceClass("Pathogenic").key).toBe("pathogenic");
    expect(significanceClass("Likely pathogenic").key).toBe("likely_pathogenic");
    expect(significanceClass("Pathogenic").color)
      .not.toBe(significanceClass("Likely pathogenic").color);
  });

  it("does not mistake 'Likely benign' for 'Benign'", () => {
    expect(significanceClass("Likely benign").key).toBe("likely_benign");
    expect(significanceClass("Benign").key).toBe("benign");
  });

  it("handles ClinVar's compound strings", () => {
    expect(significanceClass("Pathogenic/Likely pathogenic").key).toBe("pathogenic");
    expect(significanceClass("Conflicting classifications of pathogenicity").key).toBe("conflicting");
  });

  it("recognises uncertain significance", () => {
    expect(significanceClass("Uncertain significance").key).toBe("uncertain");
  });

  it("ranks severity so pathogenic sorts first", () => {
    const ranks = ["Pathogenic", "Likely pathogenic", "Uncertain significance", "Benign"]
      .map(s => significanceClass(s).rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("is not classified, rather than benign, when absent", () => {
    /* Defaulting an unclassified variant to anything reassuring would be a
       clinical misstatement. */
    expect(significanceClass(null).key).toBe("unknown");
    expect(significanceClass(undefined).label).toBe("Not classified");
  });
});

describe("evidenceLevel", () => {
  it("ranks an expert panel above a single submitter", () => {
    expect(evidenceLevel("reviewed by expert panel"))
      .toBeGreaterThan(evidenceLevel("criteria provided, single submitter"));
  });

  it("puts a practice guideline at the top", () => {
    expect(evidenceLevel("practice guideline")).toBe(3);
  });

  it("ranks multiple submitters above one", () => {
    expect(evidenceLevel("criteria provided, multiple submitters, no conflicts"))
      .toBeGreaterThan(evidenceLevel("criteria provided, single submitter"));
  });

  it("bottoms out when no criteria were provided", () => {
    expect(evidenceLevel("no assertion criteria provided")).toBe(0);
    expect(evidenceLevel(null)).toBe(0);
  });
});

describe("viewport", () => {
  const LEN = 1863;   // BRCA1

  it("starts showing the whole protein", () => {
    expect(fullView(LEN)).toEqual({ start: 1, end: 1863 });
    expect(isFullView(fullView(LEN), LEN)).toBe(true);
  });

  it("zooms in about the cursor, keeping that residue in place", () => {
    const view = zoomView(fullView(LEN), 0.5, 900, LEN);
    expect(view.end - view.start).toBeCloseTo(931, 0);
    expect(view.start).toBeLessThan(900);
    expect(view.end).toBeGreaterThan(900);
  });

  it("refuses to zoom past the point of being informative", () => {
    let view = fullView(LEN);
    for (let i = 0; i < 40; i++) view = zoomView(view, 0.5, 900, LEN);
    expect(view.end - view.start).toBeGreaterThanOrEqual(MIN_SPAN);
  });

  it("never zooms out past the protein", () => {
    const view = zoomView({ start: 800, end: 900 }, 100, 850, LEN);
    expect(view.start).toBeGreaterThanOrEqual(1);
    expect(view.end).toBeLessThanOrEqual(LEN);
  });

  it("pans without changing the width", () => {
    const before = { start: 100, end: 300 };
    const after = panView(before, 0.5, LEN);
    expect(after.end - after.start).toBe(before.end - before.start);
    expect(after.start).toBeGreaterThan(before.start);
  });

  it("stops panning at the ends instead of running off", () => {
    const atStart = panView({ start: 1, end: 200 }, -5, LEN);
    expect(atStart.start).toBe(1);
    const atEnd = panView({ start: 1663, end: 1863 }, 5, LEN);
    expect(atEnd.end).toBeLessThanOrEqual(LEN);
    expect(atEnd.end - atEnd.start).toBe(200);
  });

  it("keeps a tiny protein usable", () => {
    /* A 40-residue peptide must not produce an inverted or zero-width axis. */
    const view = fullView(40);
    expect(view.end).toBeGreaterThan(view.start);
    expect(clampView({ start: 1, end: 2 }, 40).end - clampView({ start: 1, end: 2 }, 40).start)
      .toBeGreaterThanOrEqual(MIN_SPAN);
  });
});

describe("positionVariants", () => {
  const LEN = 100;
  const variants = [
    { variant_id: "a", protein_position: 50 },
    { variant_id: "b", protein_position: 10 },
    { variant_id: "c", protein_position: null },
    { variant_id: "d", protein_position: 0 },
    { variant_id: "e", protein_position: 500 },
    { variant_id: "f", protein_position: "25" },
  ];

  it("keeps only variants that can be placed", () => {
    expect(positionVariants(variants, LEN).map(v => v.variant_id)).toEqual(["b", "f", "a"]);
  });

  it("drops positions beyond the protein rather than drawing them off the end", () => {
    expect(positionVariants(variants, LEN).find(v => v.variant_id === "e")).toBeUndefined();
  });

  it("coerces a numeric string", () => {
    expect(positionVariants(variants, LEN).find(v => v.variant_id === "f").protein_position).toBe(25);
  });

  it("returns nothing without a protein length", () => {
    expect(positionVariants(variants, null)).toEqual([]);
    expect(positionVariants(null, LEN)).toEqual([]);
  });
});

describe("filterVariants", () => {
  const variants = [
    { clinical_significance: "Pathogenic", consequence: "nonsense" },
    { clinical_significance: "Pathogenic", consequence: "missense variant" },
    { clinical_significance: "Benign", consequence: "missense variant" },
    { clinical_significance: "Uncertain significance", consequence: "splice donor variant" },
  ];

  it("filters by significance", () => {
    expect(filterVariants(variants, { significance: ["pathogenic"] })).toHaveLength(2);
  });

  it("filters by consequence", () => {
    expect(filterVariants(variants, { consequence: ["missense"] })).toHaveLength(2);
  });

  it("combines the two as an intersection", () => {
    const both = filterVariants(variants, { significance: ["pathogenic"], consequence: ["missense"] });
    expect(both).toHaveLength(1);
    expect(both[0].clinical_significance).toBe("Pathogenic");
  });

  it("shows everything when no chip is selected", () => {
    /* Switching every chip off means "no filter", not "hide the chart" — an
       empty result there reads as broken. */
    expect(filterVariants(variants, {})).toHaveLength(4);
    expect(filterVariants(variants, { significance: [], consequence: [] })).toHaveLength(4);
    expect(filterVariants(variants)).toHaveLength(4);
  });

  it("accepts a Set as well as an array", () => {
    expect(filterVariants(variants, { significance: new Set(["benign"]) })).toHaveLength(1);
  });
});

describe("facetCounts", () => {
  const variants = [
    { clinical_significance: "Pathogenic", consequence: "nonsense" },
    { clinical_significance: "Pathogenic", consequence: "frameshift variant" },
    { clinical_significance: "Benign", consequence: "missense variant" },
  ];

  it("counts each significance present", () => {
    const { significance } = facetCounts(variants);
    expect(significance.find(s => s.key === "pathogenic").count).toBe(2);
    expect(significance.find(s => s.key === "benign").count).toBe(1);
  });

  it("groups both truncating consequences together", () => {
    const { consequence } = facetCounts(variants);
    expect(consequence.find(c => c.key === "truncating").count).toBe(2);
  });

  it("offers no chip for a category with nothing in it", () => {
    const { significance } = facetCounts(variants);
    expect(significance.find(s => s.key === "uncertain")).toBeUndefined();
  });

  it("orders chips by severity, not by count", () => {
    const { significance } = facetCounts(variants);
    expect(significance.map(s => s.key)).toEqual(["pathogenic", "benign"]);
  });

  it("is safe on nothing", () => {
    expect(facetCounts([])).toEqual({ significance: [], consequence: [] });
  });
});

describe("assignLanes", () => {
  it("puts well-separated variants in one lane", () => {
    const items = [{ x: 0 }, { x: 50 }, { x: 100 }];
    const { placed, laneCount } = assignLanes(items);
    expect(laneCount).toBe(1);
    expect(placed.every(p => p.lane === 0)).toBe(true);
  });

  it("stacks variants that would overlap", () => {
    const items = [{ x: 10 }, { x: 12 }, { x: 14 }];
    const { placed } = assignLanes(items, { minGap: 11 });
    expect(new Set(placed.map(p => p.lane)).size).toBe(3);
  });

  it("adds lanes as needed rather than piling up in the last one", () => {
    /* The previous implementation had five fixed lanes and dropped every
       further collision into the fifth, drawing them on top of each other —
       the exact thing stacking exists to prevent. */
    const items = Array.from({ length: 8 }, (_, i) => ({ x: i }));
    const { placed, overflow } = assignLanes(items, { minGap: 11, maxLanes: 8 });
    expect(new Set(placed.map(p => p.lane)).size).toBe(8);
    expect(overflow).toBe(0);
  });

  it("reports what it could not place instead of hiding it", () => {
    /* Twelve variants inside half a gap's width: none can share a lane with
       any other, so four cannot be drawn at all and the caller has to be told
       rather than left believing it saw everything. */
    const items = Array.from({ length: 12 }, (_, i) => ({ x: i * 0.5 }));
    const { placed, overflow } = assignLanes(items, { minGap: 11, maxLanes: 8 });
    expect(placed).toHaveLength(8);
    expect(overflow).toBe(4);
  });

  it("lets a distant variant share an early lane", () => {
    /* Packing is about pixel distance, not order: once a variant is a full gap
       clear of lane 0's last occupant it belongs there, not in a ninth lane. */
    const items = [{ x: 0 }, { x: 1 }, { x: 11 }];
    const { placed } = assignLanes(items, { minGap: 11, maxLanes: 8 });
    expect(placed.find(p => p.x === 11).lane).toBe(0);
  });

  it("never places two variants closer than the gap within a lane", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ x: i * 3 }));
    const { placed } = assignLanes(items, { minGap: 11 });
    const byLane = {};
    for (const p of placed) (byLane[p.lane] ||= []).push(p.x);
    for (const xs of Object.values(byLane)) {
      const sorted = [...xs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(11);
      }
    }
  });

  it("carries the original item through", () => {
    const { placed } = assignLanes([{ x: 5, variant_id: "VCV1" }]);
    expect(placed[0].variant_id).toBe("VCV1");
  });
});

describe("domains", () => {
  const domains = [
    { name: "RING", type: "Domain", start: 24, end: 65 },
    { name: "Disordered", type: "Region", start: 230, end: 270 },
    { name: "BRCT 1", type: "Domain", start: 1642, end: 1736 },
    { name: "broken", start: 100, end: 50 },
    { name: "alsobroken", start: "x", end: 10 },
  ];

  it("marks disordered regions as non-structural", () => {
    /* Eleven of BRCA1's annotations are disordered regions. A map whose
       labelled bands mostly say "Disordered" tells a reader nothing. */
    const prepared = prepareDomains(domains);
    expect(prepared.find(d => d.name === "RING").structural).toBe(true);
    expect(prepared.find(d => d.name === "Disordered").structural).toBe(false);
  });

  it("drops domains with impossible coordinates", () => {
    const names = prepareDomains(domains).map(d => d.name);
    expect(names).not.toContain("broken");
    expect(names).not.toContain("alsobroken");
  });

  it("returns them in positional order", () => {
    const starts = prepareDomains(domains).map(d => d.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("finds the domain a residue sits in", () => {
    expect(domainAt(1700, domains).name).toBe("BRCT 1");
    expect(domainAt(30, domains).name).toBe("RING");
  });

  it("returns nothing between domains", () => {
    expect(domainAt(1000, domains)).toBeNull();
  });

  it("includes the boundaries", () => {
    expect(domainAt(24, domains).name).toBe("RING");
    expect(domainAt(65, domains).name).toBe("RING");
  });

  it("prefers the most specific domain when they nest", () => {
    const nested = [
      { name: "big", start: 1, end: 1000 },
      { name: "small", start: 100, end: 150 },
    ];
    expect(domainAt(120, nested).name).toBe("small");
  });

  it("is safe with no domains", () => {
    expect(domainAt(50, null)).toBeNull();
    expect(prepareDomains(null)).toEqual([]);
  });
});

describe("matchUserGenotypes", () => {
  /* Real GRCh37 coordinates inside BRCA1. ClinVar stopped publishing dbSNP
     cross-references, so every record now arrives with rsid null and a match
     keyed on rsID would find nothing at all — for any gene. */
  const dna = parseDNAFile([
    "rs799917\t17\t41245293\tCT",
    "rs1799950\t17\t41244989\tAG",
    "rs11111\t13\t32900000\tGG",     // BRCA2 territory, not on this map
  ].join("\n"));

  const variants = [
    { variant_id: "v1", rsid: null, chromosome: "17", position_grch37: 41245293 },
    { variant_id: "v2", rsid: null, chromosome: "17", position_grch37: 41200000 },  // not carried
    { variant_id: "v3", rsid: null, chromosome: null, position_grch37: null },      // unplaceable
  ];

  it("matches on position, with no rsID anywhere in sight", () => {
    const matched = matchUserGenotypes(variants, dna);
    expect(matched.get("v1").genotype).toBe("CT");
  });

  it("keys the result by variant, which is what the caller holds", () => {
    expect([...matchUserGenotypes(variants, dna).keys()]).toEqual(["v1"]);
  });

  it("matches only what the reader actually carries", () => {
    expect(matchUserGenotypes(variants, dna).has("v2")).toBe(false);
  });

  it("does not match a position on a different chromosome", () => {
    const wrongChr = [{ variant_id: "x", chromosome: "13", position_grch37: 41245293 }];
    expect(matchUserGenotypes(wrongChr, dna).size).toBe(0);
  });

  it("tolerates a chr-prefixed chromosome on either side", () => {
    const prefixed = [{ variant_id: "p", chromosome: "chr17", position_grch37: 41245293 }];
    expect(matchUserGenotypes(prefixed, dna).get("p").genotype).toBe("CT");
  });

  it("skips records with no position at all rather than matching them to anything", () => {
    expect(matchUserGenotypes(variants, dna).has("v3")).toBe(false);
  });

  it("still falls back to rsID when a source provides one", () => {
    const byRsid = [{ variant_id: "r", rsid: "rs1799950" }];
    expect(matchUserGenotypes(byRsid, dna).get("r").genotype).toBe("AG");
  });

  it("carries the reader's rsID through so the variant can be looked up", () => {
    expect(matchUserGenotypes(variants, dna).get("v1").rsid).toBe("rs799917");
  });

  it("is empty without an uploaded file", () => {
    expect(matchUserGenotypes(variants, null).size).toBe(0);
  });
});

describe("colouring a structure by variant severity", () => {
  const LEN = 1863;
  const VARIANTS = [
    { variant_id: "a", protein_position: 1700, clinical_significance: "Pathogenic" },
    { variant_id: "b", protein_position: 1700, clinical_significance: "Benign" },
    { variant_id: "c", protein_position: 1710, clinical_significance: "Benign" },
    { variant_id: "d", protein_position: 30, clinical_significance: "Uncertain significance" },
    { variant_id: "e", protein_position: 9999, clinical_significance: "Pathogenic" },
  ];

  it("takes the most severe call at a residue, never the average", () => {
    /* A position carrying both a benign and a pathogenic variant is worth
       looking at; averaging them would paint it reassuringly. */
    expect(residueSeverity(VARIANTS, LEN).get(1700).key).toBe("pathogenic");
  });

  it("counts how many variants sit on a residue", () => {
    expect(residueSeverity(VARIANTS, LEN).get(1700).count).toBe(2);
    expect(residueSeverity(VARIANTS, LEN).get(1710).count).toBe(1);
  });

  it("ignores positions outside the protein", () => {
    expect(residueSeverity(VARIANTS, LEN).has(9999)).toBe(false);
  });

  it("bundles residues into one band per colour", () => {
    const bands = variantColorBands(VARIANTS, LEN);
    expect(bands.map(b => b.key).sort()).toEqual(["benign", "pathogenic", "uncertain"]);
    expect(bands.find(b => b.key === "pathogenic").residues).toEqual([1700]);
  });

  it("paints severe last so a milder neighbour cannot overdraw it", () => {
    const bands = variantColorBands(VARIANTS, LEN);
    expect(bands[bands.length - 1].key).toBe("pathogenic");
  });

  it("gives each band a colour matching the rest of the app", () => {
    const bands = variantColorBands(VARIANTS, LEN);
    expect(bands.find(b => b.key === "pathogenic").color)
      .toBe(significanceClass("Pathogenic").color);
  });

  it("is safe with nothing to colour", () => {
    expect(variantColorBands([], LEN)).toEqual([]);
    expect(variantColorBands(null, LEN)).toEqual([]);
    expect(residueSeverity(VARIANTS, null).size).toBe(0);
  });
});
