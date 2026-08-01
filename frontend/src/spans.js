/**
 * Geometry for the structural-variant map.
 *
 * This is the one view where a *genomic* axis is the right one. The lollipop
 * map answers "which residue is broken"; a whole-exon deletion has no single
 * residue, and its meaning is entirely in how much of the gene it removes. A
 * 23 Mb copy-number loss and a 2.8% deletion are different clinical objects,
 * and only a length-faithful axis shows that.
 *
 * All coordinates are GRCh37, matching `gene_locus_grch37` and the build
 * consumer DNA files report. The backend normalises dbVar placements to GRCh37
 * for exactly this reason — mixing builds would scatter variants across a
 * region they do not occupy.
 */

// How much context to show either side of the gene, as a fraction of its
// length. Without it, a variant that starts exactly at the gene boundary is
// indistinguishable from one that began far upstream.
const FLANK = 0.35;

/** Group dbVar's vocabulary into the few kinds a reader can act on. */
const SV_KINDS = [
  { match: /deletion|loss/i, key: "loss", label: "Deletion / loss", color: "#ef4444" },
  { match: /duplication|gain/i, key: "gain", label: "Duplication / gain", color: "#3b82f6" },
  { match: /insertion/i, key: "insertion", label: "Insertion", color: "#a855f7" },
  { match: /inversion/i, key: "inversion", label: "Inversion", color: "#f59e0b" },
  { match: /copy number/i, key: "cnv", label: "Copy number change", color: "#8b5cf6" },
  { match: /delins|indel/i, key: "delins", label: "Deletion–insertion", color: "#ec4899" },
];

const UNKNOWN_KIND = { key: "other", label: "Other structural change", color: "#64748b" };

/**
 * Number(), but null and empty string are absent rather than zero.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain
 * `Number.isFinite(Number(v.start))` check treats a missing coordinate as
 * position zero — which places a variant with no location at the far left of
 * the chromosome and draws it as though that were a finding.
 */
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

function svKind(variantType) {
  if (!variantType) return UNKNOWN_KIND;
  return SV_KINDS.find(k => k.match.test(variantType)) || UNKNOWN_KIND;
}

/**
 * How much of the gene a variant covers, 0–1.
 *
 * Reported against the *gene*, not against the variant: a reader wants "this
 * removes the whole gene", not "0.3% of this variant happens to be the gene".
 * A 23 Mb copy-number loss covering all of BRCA1 is 1.0 here, which is the
 * honest reading of its effect on this gene.
 */
function geneCoverage(variant, locus) {
  if (!locus || !Number.isFinite(num(variant?.start)) || !Number.isFinite(num(variant?.end))) {
    return 0;
  }
  const gStart = num(locus.start);
  const gEnd = num(locus.end);
  const geneLength = gEnd - gStart;
  if (!(geneLength > 0)) return 0;
  const overlap = Math.min(num(variant.end), gEnd) - Math.max(num(variant.start), gStart);
  return overlap <= 0 ? 0 : Math.min(1, overlap / geneLength);
}

/**
 * Lay variants out against a windowed genomic axis.
 *
 * Returns fractional positions (0–1 across the drawn window) rather than
 * pixels, so the component owns its own dimensions. Variants wider than the
 * window are clipped and flagged, because drawing a 23 Mb variant to scale
 * would compress the gene itself to a hairline and tell the reader nothing.
 */
function layoutSpans(variants, locus, { flank = FLANK } = {}) {
  if (!locus || !Number.isFinite(num(locus.start)) || !Number.isFinite(num(locus.end))) {
    return { rows: [], window: null, gene: null };
  }
  const gStart = num(locus.start);
  const gEnd = num(locus.end);
  const geneLength = gEnd - gStart;
  if (!(geneLength > 0)) return { rows: [], window: null, gene: null };

  const pad = geneLength * flank;
  const wStart = gStart - pad;
  const wEnd = gEnd + pad;
  const wLength = wEnd - wStart;
  const frac = (pos) => (pos - wStart) / wLength;

  const placed = (variants || [])
    .filter(v => Number.isFinite(num(v.start)) && Number.isFinite(num(v.end)))
    .map(v => {
      const s = num(v.start);
      const e = num(v.end);
      const x0 = frac(Math.max(s, wStart));
      const x1 = frac(Math.min(e, wEnd));
      return {
        ...v,
        kind: svKind(v.variant_type),
        coverage: geneCoverage(v, locus),
        x0: Math.max(0, Math.min(1, x0)),
        // A zero-width bar is invisible; give single-base events a hairline.
        x1: Math.max(Math.max(0, Math.min(1, x1)), Math.max(0, Math.min(1, x0)) + 0.004),
        clippedLeft: s < wStart,
        clippedRight: e > wEnd,
      };
    });

  // Widest first, so the variants that erase the gene are read before the ones
  // that nick it.
  placed.sort((a, b) => (b.coverage - a.coverage) || ((b.span_bp || 0) - (a.span_bp || 0)));

  return {
    rows: placed,
    window: { start: wStart, end: wEnd },
    gene: { x0: frac(gStart), x1: frac(gEnd), start: gStart, end: gEnd },
  };
}

/** Which kinds are present, for a legend that lists only what is drawn. */
function spanLegend(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    if (!seen.has(r.kind.key)) seen.set(r.kind.key, r.kind);
  }
  return [...seen.values()];
}

/** Human-readable base-pair length. */
function formatBp(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} Mb`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)} kb`;
  return `${n} bp`;
}

export { layoutSpans, geneCoverage, svKind, spanLegend, formatBp, SV_KINDS, UNKNOWN_KIND, FLANK };
