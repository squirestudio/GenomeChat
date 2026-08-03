/**
 * The reader's own sequence, drawn as the molecule it is.
 *
 * The karyogram shows where their readings sit across the genome. This shows
 * what those readings *are*, at one gene, as a double helix — which is the
 * picture everyone already has in their head and has almost certainly never
 * seen filled in with their own bases.
 *
 * **One correctness point shapes the whole design.** A rung of a double helix is
 * a base *pair* — A opposite T, G opposite C — held together across two
 * complementary strands of one molecule. A genotype like "AG" is not that: it
 * means one of your two chromosome copies reads A at that position and the other
 * reads G. Drawing "A—G" as a rung would be teaching something false.
 *
 * So: the rung is drawn as a true complementary pair from one allele, and a
 * position where the two copies differ is *marked* as heterozygous rather than
 * fudged into the ladder. That marking is the interesting part — it is where a
 * reader can see, concretely, that they have two copies of everything.
 *
 * Rungs are positioned by real genomic coordinate, so the gaps are literal. A
 * gene with eleven genotyped positions across 80,000 bases draws as a mostly
 * bare backbone with eleven coloured rungs, and that is the honest picture of
 * what a consumer array read.
 */

/** Watson–Crick pairing. The only pairs that exist in B-form DNA. */
const COMPLEMENT = { A: "T", T: "A", G: "C", C: "G" };

/** Conventional base colours, the ones every sequencing tool uses. */
const BASE_COLOR = { A: "#22c55e", T: "#ef4444", G: "#f59e0b", C: "#3b82f6" };

/**
 * The single-base alleles in a genotype, as `[first, second|null]`.
 *
 * Indels ("II", "DD") and no-calls ("--") survive the filter as nothing, which
 * is correct: neither is a base pair and neither can honestly be drawn as a rung.
 *
 * A single letter is **hemizygous**, not homozygous — 23andMe reports one base
 * on the Y chromosome and for mitochondrial positions because there genuinely is
 * only one copy. Expanding "A" into "AA" would claim a second copy that does not
 * exist, so the second allele stays null and the caller says so.
 */
function alleles(genotype) {
  const s = String(genotype ?? "").toUpperCase().replace(/[^ACGT]/g, "");
  if (s.length >= 2) return [s[0], s[1]];
  if (s.length === 1) return [s[0], null];
  return [];
}

/**
 * How a reading relates to the two copies a person carries.
 *
 * `heterozygous` is the one worth surfacing. `homozygous` covers both "two
 * reference copies" and "two variant copies" — telling those apart needs a
 * reference base, which a consumer file does not carry, so claiming the
 * difference would be inventing it.
 */
function zygosity(genotype) {
  const [a, b] = alleles(genotype);
  if (!a) return null;
  if (!b) return "hemizygous";
  return a === b ? "homozygous" : "heterozygous";
}

/**
 * Lay out rungs for one gene from the reader's readings in it.
 *
 * Returns `{ rungs, span, kept, skipped }`. Rungs carry a fractional position
 * along the gene (0–1) so the caller decides the pixel geometry, and the pair
 * is always complementary — see the note at the top of this file.
 */
function buildHelix(hits, locus, { maxRungs = 60 } = {}) {
  const start = Number(locus?.start);
  const end = Number(locus?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { rungs: [], span: 0, kept: 0, skipped: 0 };
  }
  const span = end - start;

  const usable = [];
  let skipped = 0;
  for (const h of hits || []) {
    const pos = Number(h?.position);
    const [a, b] = alleles(h?.genotype);
    if (!a || !Number.isFinite(pos) || pos < start || pos > end) {
      skipped++;
      continue;
    }
    usable.push({
      rsid: h.rsid,
      position: pos,
      // The drawn pair: one allele and its true complement.
      base: a,
      pair: COMPLEMENT[a] || "?",
      other: b,
      zygosity: zygosity(h?.genotype),
      genotype: b ? `${a}${b}` : a,
      at: (pos - start) / span,
    });
  }
  usable.sort((x, y) => x.position - y.position);

  // Too many rungs and the helix becomes a solid band. Thinned evenly across
  // the gene rather than truncated, so the shape still reflects the whole span.
  //
  // The endpoints are pinned deliberately. Sampling at `i * length / max` never
  // lands on the final element, so the helix always appeared to stop short of
  // the end of the gene — a small lie about where the reader's data runs to.
  let rungs = usable;
  if (usable.length > maxRungs) {
    const last = usable.length - 1;
    const step = last / (maxRungs - 1);
    const picked = new Set();
    for (let i = 0; i < maxRungs; i++) picked.add(Math.round(i * step));
    rungs = [...picked].sort((a, b) => a - b).map(i => usable[i]);
  }
  return { rungs, span, kept: usable.length, skipped };
}

/**
 * Points along one strand of a helix, as a sine wave.
 *
 * The second strand is the same wave shifted half a period, which is what makes
 * the two backbones cross — the visual signature of a double helix rather than
 * a ladder.
 */
function strandPath(width, height, turns, phase = 0, steps = 120) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = t * width;
    const y = height / 2 + (height / 2 - 2) * Math.sin(turns * 2 * Math.PI * t + phase);
    pts.push([x, y]);
  }
  return pts;
}

/** Where a rung's two ends sit, given its fractional position along the gene. */
function rungEnds(at, width, height, turns) {
  const x = at * width;
  const wave = Math.sin(turns * 2 * Math.PI * at);
  const y1 = height / 2 + (height / 2 - 2) * wave;
  const y2 = height / 2 - (height / 2 - 2) * wave;
  return { x, y1, y2, depth: Math.abs(wave) };
}

/** How much of a gene the reader's file actually covers, as one in N bases. */
function helixCoverage(kept, span) {
  if (!kept || !span) return null;
  return Math.round(span / kept);
}

export {
  COMPLEMENT, BASE_COLOR, alleles, zygosity, buildHelix,
  strandPath, rungEnds, helixCoverage,
};
