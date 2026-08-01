import { describe, it, expect } from "vitest";
import { layoutSpans, geneCoverage, svKind, spanLegend, formatBp } from "./spans";

// BRCA1 on GRCh37, and real dbVar variants measured against it.
const BRCA1 = { chromosome: "17", start: 41196312, end: 41277500, assembly: "GRCh37" };
const GENE_LEN = BRCA1.end - BRCA1.start;

describe("svKind", () => {
  it("separates the kinds that mean different things clinically", () => {
    expect(svKind("copy number loss").key).toBe("loss");
    expect(svKind("copy number gain").key).toBe("gain");
    expect(svKind("inversion").key).toBe("inversion");
    expect(svKind("delins").key).toBe("delins");
  });

  it("gives loss and gain different colours", () => {
    /* Losing a tumour-suppressor gene and duplicating it are opposite events;
       drawing them alike would be worse than not colouring at all. */
    expect(svKind("deletion").color).not.toBe(svKind("duplication").color);
  });

  it("classifies a bare copy number variation rather than dropping it", () => {
    expect(svKind("copy number variation").key).toBe("cnv");
  });

  it("falls back rather than throwing", () => {
    expect(svKind(null).key).toBe("other");
    expect(svKind("something new").key).toBe("other");
  });
});

describe("geneCoverage", () => {
  it("reports a variant that spans the whole gene as complete", () => {
    /* A 23 Mb copy-number loss really does remove all of BRCA1. Reporting the
       fraction of the *variant* would say 0.3% and mislead entirely. */
    const huge = { start: 30000000, end: 53000000 };
    expect(geneCoverage(huge, BRCA1)).toBe(1);
  });

  it("measures a partial overlap against the gene's length", () => {
    const half = { start: BRCA1.start, end: BRCA1.start + GENE_LEN / 2 };
    expect(geneCoverage(half, BRCA1)).toBeCloseTo(0.5, 2);
  });

  it("returns zero for a variant that misses the gene", () => {
    expect(geneCoverage({ start: 10, end: 1000 }, BRCA1)).toBe(0);
  });

  it("returns zero when the variant merely abuts the gene", () => {
    expect(geneCoverage({ start: BRCA1.end, end: BRCA1.end + 5000 }, BRCA1)).toBe(0);
  });

  it("is safe on missing coordinates", () => {
    expect(geneCoverage({ start: null, end: null }, BRCA1)).toBe(0);
    expect(geneCoverage({ start: 1, end: 2 }, null)).toBe(0);
  });
});

describe("layoutSpans", () => {
  const variants = [
    { accession: "nsv-small", variant_type: "delins", start: 41244000, end: 41246000, span_bp: 2000 },
    { accession: "nsv-whole", variant_type: "copy number loss", start: 30000000, end: 53000000, span_bp: 23000000 },
    { accession: "nsv-part", variant_type: "deletion", start: 41196312, end: 41240000, span_bp: 43688 },
  ];

  it("places the gene inside the window with context either side", () => {
    const { gene } = layoutSpans(variants, BRCA1);
    expect(gene.x0).toBeGreaterThan(0);
    expect(gene.x1).toBeLessThan(1);
    expect(gene.x1).toBeGreaterThan(gene.x0);
  });

  it("orders by how much of the gene each variant removes", () => {
    /* The one that erases the gene should be read first, not the one that
       happens to appear first in dbVar's response. */
    const order = layoutSpans(variants, BRCA1).rows.map(r => r.accession);
    expect(order[0]).toBe("nsv-whole");
    expect(order[order.length - 1]).toBe("nsv-small");
  });

  it("clips a variant far wider than the window, and says so", () => {
    const whole = layoutSpans(variants, BRCA1).rows.find(r => r.accession === "nsv-whole");
    expect(whole.clippedLeft).toBe(true);
    expect(whole.clippedRight).toBe(true);
    expect(whole.x0).toBe(0);
    expect(whole.x1).toBe(1);
  });

  it("does not claim clipping for a variant that fits", () => {
    const small = layoutSpans(variants, BRCA1).rows.find(r => r.accession === "nsv-small");
    expect(small.clippedLeft).toBe(false);
    expect(small.clippedRight).toBe(false);
  });

  it("keeps every bar wide enough to see", () => {
    /* A single-base event is a real finding and a zero-width rectangle is an
       invisible one. */
    const tiny = layoutSpans(
      [{ accession: "pt", variant_type: "insertion", start: 41244607, end: 41244607, span_bp: 1 }],
      BRCA1,
    ).rows[0];
    expect(tiny.x1 - tiny.x0).toBeGreaterThan(0);
  });

  it("keeps positions inside the drawn window", () => {
    for (const r of layoutSpans(variants, BRCA1).rows) {
      expect(r.x0).toBeGreaterThanOrEqual(0);
      expect(r.x1).toBeLessThanOrEqual(1);
      expect(r.x1).toBeGreaterThan(r.x0);
    }
  });

  it("drops variants with no coordinates rather than drawing them at zero", () => {
    const mixed = [...variants, { accession: "nsv-noloc", variant_type: "deletion", start: null, end: null }];
    expect(layoutSpans(mixed, BRCA1).rows.map(r => r.accession)).not.toContain("nsv-noloc");
  });

  it("returns nothing usable without a locus", () => {
    expect(layoutSpans(variants, null).rows).toEqual([]);
    expect(layoutSpans(variants, { start: 100, end: 100 }).rows).toEqual([]);
  });

  it("is safe with no variants", () => {
    expect(layoutSpans([], BRCA1).rows).toEqual([]);
    expect(layoutSpans(null, BRCA1).rows).toEqual([]);
  });
});

describe("spanLegend", () => {
  it("lists only the kinds actually drawn", () => {
    const { rows } = layoutSpans([
      { accession: "a", variant_type: "deletion", start: 41200000, end: 41210000 },
      { accession: "b", variant_type: "deletion", start: 41220000, end: 41230000 },
    ], BRCA1);
    expect(spanLegend(rows).map(k => k.key)).toEqual(["loss"]);
  });

  it("is empty when nothing is drawn", () => {
    expect(spanLegend([])).toEqual([]);
  });
});

describe("formatBp", () => {
  it("scales to readable units", () => {
    expect(formatBp(500)).toBe("500 bp");
    expect(formatBp(8079)).toBe("8.1 kb");
    expect(formatBp(104140)).toBe("104 kb");
    expect(formatBp(23322865)).toBe("23 Mb");
  });

  it("returns nothing for a missing length rather than 'NaN bp'", () => {
    expect(formatBp(null)).toBeNull();
    expect(formatBp(undefined)).toBeNull();
  });
});
