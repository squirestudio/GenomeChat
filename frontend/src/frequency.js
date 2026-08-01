/**
 * Making a rare frequency legible.
 *
 * gnomAD reports pathogenic-variant frequencies around 0.001. Drawn as a bar
 * chart that is a row of bars all pinned at zero — the chart occupies real
 * estate and communicates nothing, and worse, it invites the reader to compare
 * lengths that are visually identical.
 *
 * Two things actually help. "1 in 833" is a number people can hold. And a grid
 * where one dot in 833 is filled shows rarity as an image rather than as a
 * decimal. The grid has to be scaled to the frequency, though: a hundred dots
 * cannot represent one-in-833, and ten thousand dots cannot be counted.
 */

// Grids people can read at a glance, smallest first. Ten thousand is the
// ceiling — beyond that the dots are sub-pixel and the picture is a smudge.
const SCALES = [100, 1000, 10000];

/**
 * Pick a grid where at least one dot is filled and the fill stays countable.
 *
 * Returns null below one-in-ten-thousand: at that point no honest grid works,
 * and the "1 in N" figure carries it alone. Saying so beats drawing a grid
 * that rounds someone's variant out of existence.
 */
function pictogramScale(frequency) {
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0) return null;
  if (f >= 1) return { total: 100, filled: 100, scale: 100 };

  for (const total of SCALES) {
    const filled = Math.round(f * total);
    if (filled >= 1) return { total, filled: Math.min(filled, total), scale: total };
  }
  return null;
}

/**
 * "1 in 833" — the phrasing people actually reason with.
 *
 * Rounded to something speakable rather than exact: "1 in 833" is a fact,
 * "1 in 832.6" is a decimal wearing a fact's clothes.
 */
function oneInPhrase(frequency) {
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0) return null;
  if (f >= 0.5) return `${Math.round(f * 100)} in 100`;
  const n = 1 / f;
  if (n >= 1000) return `1 in ${Math.round(n / 100) * 100}`;
  if (n >= 100) return `1 in ${Math.round(n / 10) * 10}`;
  return `1 in ${Math.round(n)}`;
}

/**
 * Populations ordered for comparison, with each one's share of the highest.
 *
 * The relative figure is what a bar can honestly show at these magnitudes —
 * absolute length is hopeless when every value rounds to zero, but "twice as
 * common here as there" is both true and visible.
 */
function comparePopulations(populations) {
  const rows = (populations || [])
    .filter(p => Number.isFinite(Number(p?.allele_frequency)) && Number(p.allele_frequency) > 0)
    .map(p => ({
      id: p.population_id || p.population,
      name: p.population || p.population_id,
      frequency: Number(p.allele_frequency),
      alleleCount: Number(p.allele_count) || null,
      alleleNumber: Number(p.allele_number) || null,
      phrase: oneInPhrase(p.allele_frequency),
    }));
  if (!rows.length) return { rows: [], max: 0, spread: null };

  const max = Math.max(...rows.map(r => r.frequency));
  const min = Math.min(...rows.map(r => r.frequency));
  rows.sort((a, b) => b.frequency - a.frequency);
  for (const r of rows) r.relative = r.frequency / max;

  return {
    rows,
    max,
    // How much the most and least affected populations differ. Worth stating
    // only when it is large enough to mean something.
    spread: min > 0 && max / min >= 1.5 ? Math.round((max / min) * 10) / 10 : null,
  };
}

export { pictogramScale, oneInPhrase, comparePopulations, SCALES };
