/**
 * Geometry and encoding for the variant map.
 *
 * Kept apart from the component because all of it is arithmetic that can be
 * checked — lane packing, zoom clamping, coordinate transforms — and because
 * the component around it is SVG that would make these rules very hard to see.
 *
 * The map's premise: a reader asks which part of the protein is broken and how
 * badly. Protein position answers the first, and it is an axis a genome browser
 * cannot offer — 1,863 residues of BRCA1 fit one screen where 81,000 bases of
 * DNA do not.
 */

// ─── Consequence → glyph ─────────────────────────────────────────────────────
// Shape carries what kind of damage a variant does, leaving colour free to
// carry how certain we are that it matters. Encoding both on colour alone
// would make the two impossible to read apart.
//
// Vocabulary is ClinVar's `molecular_consequence_list`, which is a small
// controlled set — see test_ncbi_sources.py, which asserts that.

const CONSEQUENCE_CLASS = [
  // Order matters: the first match wins, and "splice" must be tested before
  // the truncating terms because a splice variant is often also frameshifting.
  { match: /splice/i, key: "splice", glyph: "diamond", label: "Splice site" },
  { match: /frameshift|nonsense|stop.?gain|stop.?lost|initiator/i, key: "truncating", glyph: "square", label: "Truncating" },
  { match: /missense/i, key: "missense", glyph: "circle", label: "Missense" },
  { match: /inframe/i, key: "inframe", glyph: "triangle", label: "In-frame indel" },
  { match: /synonymous/i, key: "silent", glyph: "hollow", label: "Synonymous" },
  { match: /utr|non-coding|intron|upstream|downstream/i, key: "noncoding", glyph: "dot", label: "Non-coding" },
];

const UNKNOWN_CONSEQUENCE = { key: "other", glyph: "circle", label: "Other / unspecified" };

function consequenceClass(consequence) {
  if (!consequence) return UNKNOWN_CONSEQUENCE;
  return CONSEQUENCE_CLASS.find(c => c.match.test(consequence)) || UNKNOWN_CONSEQUENCE;
}

// ─── Significance → colour and severity ──────────────────────────────────────

const SIGNIFICANCE = [
  { match: /^pathogenic$|^pathogenic[,/]/i, key: "pathogenic", color: "#ef4444", label: "Pathogenic", rank: 0 },
  { match: /likely pathogenic/i, key: "likely_pathogenic", color: "#f97316", label: "Likely pathogenic", rank: 1 },
  { match: /conflicting/i, key: "conflicting", color: "#a855f7", label: "Conflicting", rank: 2 },
  { match: /uncertain|^vus$/i, key: "uncertain", color: "#eab308", label: "Uncertain (VUS)", rank: 3 },
  { match: /likely benign/i, key: "likely_benign", color: "#14b8a6", label: "Likely benign", rank: 4 },
  { match: /^benign/i, key: "benign", color: "#22c55e", label: "Benign", rank: 5 },
];

const UNKNOWN_SIGNIFICANCE = { key: "unknown", color: "#94a3b8", label: "Not classified", rank: 6 };

function significanceClass(significance) {
  if (!significance) return UNKNOWN_SIGNIFICANCE;
  return SIGNIFICANCE.find(s => s.match.test(significance)) || UNKNOWN_SIGNIFICANCE;
}

/**
 * How much evidence stands behind a classification, 0–3.
 *
 * ClinVar's review status is prose, and the difference between one submitter's
 * opinion and an expert panel is exactly the thing a reader should be able to
 * see without reading it. Drives opacity, so weakly-supported calls recede.
 */
function evidenceLevel(reviewStatus) {
  const s = String(reviewStatus || "").toLowerCase();
  if (s.includes("practice guideline")) return 3;
  if (s.includes("expert panel")) return 3;
  if (s.includes("multiple submitters")) return 2;
  if (s.includes("criteria provided")) return 1;
  return 0;
}

// ─── Viewport ────────────────────────────────────────────────────────────────

// Below about 12 residues the axis stops being informative and the lollipops
// are further apart than the protein they sit on.
const MIN_SPAN = 12;

function fullView(proteinLength) {
  return { start: 1, end: Math.max(proteinLength, MIN_SPAN) };
}

/** Clamp a window to the protein, preserving its width where possible. */
function clampView(view, proteinLength) {
  const max = Math.max(proteinLength, MIN_SPAN);
  let span = Math.min(Math.max(view.end - view.start, MIN_SPAN), max - 1 + 1);
  let start = view.start;
  if (start < 1) start = 1;
  if (start + span > max) start = Math.max(1, max - span);
  return { start: Math.round(start), end: Math.round(start + span) };
}

/**
 * Zoom about a fixed point, so whatever is under the cursor stays under it.
 * `factor` < 1 zooms in.
 */
function zoomView(view, factor, focusPos, proteinLength) {
  const span = view.end - view.start;
  const nextSpan = Math.max(MIN_SPAN, Math.min(span * factor, Math.max(proteinLength, MIN_SPAN)));
  // Where the focus sits within the current window, kept constant.
  const ratio = span === 0 ? 0.5 : (focusPos - view.start) / span;
  return clampView({ start: focusPos - ratio * nextSpan, end: focusPos - ratio * nextSpan + nextSpan }, proteinLength);
}

/** Pan by a fraction of the visible width. Positive moves toward the C-terminus. */
function panView(view, fraction, proteinLength) {
  const span = view.end - view.start;
  const delta = span * fraction;
  return clampView({ start: view.start + delta, end: view.end + delta }, proteinLength);
}

function isFullView(view, proteinLength) {
  const full = fullView(proteinLength);
  return view.start <= full.start && view.end >= full.end;
}

// ─── Selection and filtering ─────────────────────────────────────────────────

/** Variants with a usable position, in order. */
function positionVariants(variants, proteinLength) {
  if (!proteinLength) return [];
  return (variants || [])
    .filter(v => Number.isFinite(Number(v.protein_position)))
    .filter(v => Number(v.protein_position) > 0 && Number(v.protein_position) <= proteinLength)
    .map(v => ({ ...v, protein_position: Number(v.protein_position) }))
    .sort((a, b) => a.protein_position - b.protein_position);
}

/**
 * Apply the filter chips. An empty set means "no filter", not "exclude
 * everything" — a reader who has switched all chips off wants to see
 * everything back, not an empty chart.
 */
function filterVariants(variants, { significance, consequence } = {}) {
  const sig = significance instanceof Set ? significance : new Set(significance || []);
  const con = consequence instanceof Set ? consequence : new Set(consequence || []);
  return (variants || []).filter(v => {
    if (sig.size && !sig.has(significanceClass(v.clinical_significance).key)) return false;
    if (con.size && !con.has(consequenceClass(v.consequence).key)) return false;
    return true;
  });
}

/** Which of the filter chips are worth showing, with counts. */
function facetCounts(variants) {
  const sig = new Map();
  const con = new Map();
  for (const v of variants || []) {
    const s = significanceClass(v.clinical_significance);
    const c = consequenceClass(v.consequence);
    sig.set(s.key, (sig.get(s.key) || 0) + 1);
    con.set(c.key, (con.get(c.key) || 0) + 1);
  }
  const bySig = SIGNIFICANCE.concat([UNKNOWN_SIGNIFICANCE])
    .filter(s => sig.has(s.key))
    .map(s => ({ ...s, count: sig.get(s.key) }));
  const byCon = CONSEQUENCE_CLASS.concat([UNKNOWN_CONSEQUENCE])
    .filter(c => con.has(c.key))
    .map(c => ({ ...c, count: con.get(c.key) }));
  return { significance: bySig, consequence: byCon };
}

// ─── Lane packing ────────────────────────────────────────────────────────────

/**
 * Stack overlapping lollipops so none hides another.
 *
 * Lanes grow as needed rather than being capped: the previous version had five
 * and dropped every further collision into the last one, which drew them on
 * top of each other — the exact thing stacking exists to prevent. Anything
 * beyond `maxLanes` is reported as `overflow` so the caller can say so out
 * loud instead of silently drawing a lie.
 */
function assignLanes(items, { minGap = 11, maxLanes = 8 } = {}) {
  const laneEnds = [];
  const placed = [];
  let overflow = 0;

  for (const item of items) {
    let lane = laneEnds.findIndex(end => item.x - end >= minGap);
    if (lane === -1) {
      if (laneEnds.length < maxLanes) {
        laneEnds.push(-Infinity);
        lane = laneEnds.length - 1;
      } else {
        overflow += 1;
        continue;
      }
    }
    laneEnds[lane] = item.x;
    placed.push({ ...item, lane });
  }
  return { placed, laneCount: laneEnds.length, overflow };
}

// ─── Domains ─────────────────────────────────────────────────────────────────

/** The domain a residue falls in, preferring the most specific (smallest). */
function domainAt(position, domains) {
  const hits = (domains || []).filter(
    d => Number(position) >= Number(d.start) && Number(position) <= Number(d.end),
  );
  if (!hits.length) return null;
  return hits.reduce((best, d) =>
    (Number(d.end) - Number(d.start)) < (Number(best.end) - Number(best.start)) ? d : best);
}

/**
 * Domains worth drawing as named bands.
 *
 * UniProt returns long runs of "Disordered" regions — eleven of BRCA1's
 * annotations are those. They are real, but a map where most labelled bands say
 * "Disordered" tells a reader nothing about which part matters, so they are
 * marked for muted rendering rather than dropped.
 */
function prepareDomains(domains) {
  return (domains || [])
    .filter(d => Number.isFinite(Number(d.start)) && Number.isFinite(Number(d.end)) && Number(d.end) > Number(d.start))
    .map(d => ({
      ...d,
      start: Number(d.start),
      end: Number(d.end),
      structural: !/disorder|region/i.test(`${d.name} ${d.type || ""}`),
    }))
    .sort((a, b) => a.start - b.start);
}

// ─── The reader's own variants ───────────────────────────────────────────────

/**
 * Match an uploaded file against the variants on the map, by rsID.
 *
 * Returns a Map keyed by rsID. Only ClinVar records carrying an rsID can match,
 * which is a real limitation and the reason the panel states how many did.
 */
function matchUserGenotypes(variants, dnaData) {
  const out = new Map();
  if (!dnaData || !dnaData.variants) return out;
  for (const v of variants || []) {
    if (!v.rsid) continue;
    const mine = dnaData.variants.get(v.rsid);
    if (mine) out.set(v.rsid, mine);
  }
  return out;
}

export {
  consequenceClass, significanceClass, evidenceLevel,
  fullView, clampView, zoomView, panView, isFullView, MIN_SPAN,
  positionVariants, filterVariants, facetCounts,
  assignLanes, domainAt, prepareDomains, matchUserGenotypes,
  CONSEQUENCE_CLASS, SIGNIFICANCE, UNKNOWN_SIGNIFICANCE, UNKNOWN_CONSEQUENCE,
};
