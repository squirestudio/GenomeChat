/**
 * Genome-wide association results, arranged honestly.
 *
 * Two constraints shape this, and both rule out the obvious chart.
 *
 * A volcano plot needs a shared effect-size axis, and there isn't one. Effect
 * sizes arrive as beta values in whatever unit the study measured — `unit`,
 * `SD unit`, `year`, `z score`, `nmol/L` — so a beta of 0.07 and one of 0.45
 * are not comparable quantities. Odds ratios, which would be comparable, are
 * almost absent: zero of APOE's associations carry one. Plotting beta on a
 * common axis would invent a comparison the data does not support.
 *
 * And most "traits" are molecular measurements rather than conditions. Six of
 * APOE's nine associations are protein or lipid levels, which buries
 * Alzheimer's disease — the single best-known association this gene has —
 * among readings of nectin-2. Diseases are separated out and lead.
 *
 * Significance is the one axis that *is* comparable across traits, so it is
 * the one that gets a bar.
 */

// Traits phrased as a quantity being measured rather than a condition. These
// are pQTL and biomarker studies: real, but a different question from "what is
// this gene associated with".
const MEASUREMENT = /measurement|level(?:s)? of|\blevels?\b|\bratio\b|\bcount\b|concentration|\bamount of\b|quantity/i;

function classifyTrait(trait) {
  return MEASUREMENT.test(String(trait || "")) ? "measurement" : "condition";
}

/**
 * -log10(p), which is how significance is compared.
 *
 * p can arrive as exactly 0 when a study's value underflows float64, and
 * -log10(0) is Infinity. Capped at 300, a little beyond the smallest
 * representable double, so one underflowed result cannot flatten every other
 * bar to nothing.
 */
const NEG_LOG_CAP = 300;

function negLogP(p) {
  // null and "" must be absent, not zero. `Number(null)` is 0 and
  // `Number.isFinite(0)` is true, so a plain coercion turns a missing p-value
  // into p = 0 — the most significant result possible — and it then caps at
  // 300 and outranks every real finding. Second time this trap has appeared;
  // see the same guard in spans.js.
  if (p === null || p === undefined || p === "") return null;
  const value = Number(p);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value === 0) return NEG_LOG_CAP;
  return Math.min(NEG_LOG_CAP, -Math.log10(value));
}

/** Readable significance, since -log10 means nothing to most readers. */
function formatP(p) {
  const value = Number(p);
  if (!Number.isFinite(value)) return null;
  if (value === 0) return "p < 1e-300";
  if (value >= 0.001) return `p = ${value.toPrecision(2)}`;
  const exponent = Math.floor(Math.log10(value));
  return `p = 1e${exponent}`;
}

/**
 * The effect, as a phrase rather than a number on a shared scale.
 *
 * Direction survives the unit problem — "raises" and "lowers" mean the same
 * thing whatever was measured — so it is stated, while the magnitude is
 * reported with its own unit attached and never plotted against another trait.
 */
function effectPhrase(hit) {
  if (hit?.odds_ratio != null) {
    const or = Number(hit.odds_ratio);
    if (Number.isFinite(or)) {
      return { direction: or >= 1 ? "up" : "down", text: `odds ratio ${or.toFixed(2)}` };
    }
  }
  if (hit?.beta != null) {
    const beta = Number(hit.beta);
    if (Number.isFinite(beta)) {
      const stated = String(hit.beta_direction || "").toLowerCase();
      const direction = stated.startsWith("inc") ? "up"
        : stated.startsWith("dec") ? "down"
          : beta >= 0 ? "up" : "down";
      // "unit" is what the catalogue records when a study did not name one; it
      // carries no information and reads as though it did.
      const unit = hit.beta_unit && hit.beta_unit !== "unit" ? ` ${hit.beta_unit}` : "";
      return { direction, text: `${beta > 0 ? "+" : ""}${Number(beta.toFixed(3))}${unit}` };
    }
  }
  return { direction: null, text: null };
}

/**
 * Associations grouped into conditions and measurements, ranked by
 * significance within each, with bars relative to the strongest in the group.
 */
function rankAssociations(hits, { limit = 10 } = {}) {
  const rows = (hits || [])
    .filter(h => h?.trait)
    .map(h => ({
      trait: h.trait,
      rsid: h.rsid,
      url: h.url,
      kind: classifyTrait(h.trait),
      p: Number(h.p_value),
      negLog: negLogP(h.p_value),
      pText: formatP(h.p_value),
      riskAllele: h.risk_allele || null,
      // How common the risk allele is. Without it a reader cannot tell whether
      // an association describes something they are likely to carry or a rare
      // variant — the same distinction the population panel exists to make.
      // Fetched from the GWAS Catalog and previously discarded here.
      riskFrequency: typeof h.risk_frequency === "number" ? h.risk_frequency : null,
      ...effectPhrase(h),
    }))
    .filter(r => r.negLog !== null);

  const group = (kind) => {
    const inGroup = rows.filter(r => r.kind === kind)
      .sort((a, b) => b.negLog - a.negLog)
      .slice(0, limit);
    const top = inGroup.length ? inGroup[0].negLog : 0;
    // Relative within the group: comparing a disease association against a
    // protein-level one on the same axis is the mixing this separation exists
    // to prevent.
    for (const r of inGroup) r.relative = top ? r.negLog / top : 0;
    return inGroup;
  };

  return {
    conditions: group("condition"),
    measurements: group("measurement"),
    conditionTotal: rows.filter(r => r.kind === "condition").length,
    measurementTotal: rows.filter(r => r.kind === "measurement").length,
  };
}

export { rankAssociations, classifyTrait, negLogP, formatP, effectPhrase, NEG_LOG_CAP };
