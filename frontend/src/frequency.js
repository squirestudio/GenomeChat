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

/**
 * One grid for every group in a panel, so they can be compared.
 *
 * Scaling each group independently was the flaw: at CFTR's frequencies the
 * most and least affected groups both resolved to a single filled dot, hiding
 * the 2x difference the panel exists to show. The grid is now chosen from the
 * *smallest* frequency present, so even the rarest group fills at least one
 * dot — and the others then fill proportionally more.
 */
/* A grid has to separate the groups, not merely show them.
 *
 * The old rule asked only that the rarest group register one dot, which is a
 * visibility test, not a comparison test — and this panel exists to compare.
 * For a gene whose groups run from 1 in 720 to 1 in 1,000, it chose the
 * thousand-dot grid, where every one of the seven rounds to exactly one dot.
 * Seven visibly identical pictures for seven different numbers, sitting
 * directly above a bar chart that showed the differences perfectly well.
 *
 * The test is *spread*, not an absolute count. Requiring the rarest group to
 * reach some minimum number of dots was tried and is wrong in the other
 * direction: 16 dots against 9 is perfectly legible on a hundred-grid, and
 * forcing a finer one there makes a common variant look rarer than it is.
 * What matters is that the distance between the most and least common group
 * covers enough dots to see. Three is the floor — 13 against 10 reads as
 * different at a glance; 1 against 1 does not. */
const MIN_SPREAD_DOTS = 3;

function sharedPictogramScale(frequencies) {
  const values = (frequencies || [])
    .map(Number)
    .filter(f => Number.isFinite(f) && f > 0);
  if (!values.length) return null;

  const smallest = Math.min(...values);
  const largest = Math.max(...values);
  if (largest >= 1) return { total: 100, scale: 100 };

  // First choice: the coarsest grid on which the groups visibly separate and
  // the rarest still registers. A single group has no spread to measure, so it
  // only has to register.
  const spread = largest - smallest;
  for (const total of SCALES) {
    const registers = smallest * total >= 1;
    const separates = values.length < 2 || spread * total >= MIN_SPREAD_DOTS;
    if (registers && separates) return { total, scale: total };
  }
  // Nothing on the scale ladder can separate them — the variant is rare enough
  // that even ten thousand dots leaves fractions. Take the finest grid and let
  // partial fill carry the difference rather than rounding it away.
  const finest = SCALES[SCALES.length - 1];
  return { total: finest, scale: finest };
}

/**
 * How much of the grid a frequency fills, whole dots and a remainder.
 *
 * The remainder is the point. Rounding to whole dots is what made seven
 * different frequencies draw the same picture, and it also meant `filledOn`
 * had to round *up* to one — showing a full dot for two tenths of one, which
 * overstates a rare variant in the one panel meant to convey rarity.
 */
function fillOn(frequency, total) {
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0 || !total) return { whole: 0, partial: 0, exact: 0 };
  const exact = Math.min(total, f * total);
  const whole = Math.floor(exact);
  return {
    whole,
    // A sliver below this is indistinguishable from an empty cell, and an
    // empty cell reads as "nobody here" rather than "very rare" — the same
    // failure the old visibility rule was written to avoid.
    partial: whole >= total ? 0 : Math.max(exact - whole, exact > 0 && whole === 0 ? 0.18 : 0),
    exact,
  };
}

/** Whole dots only. Kept for callers that need a count rather than a drawing. */
function filledOn(frequency, total) {
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0 || !total) return 0;
  return Math.min(total, Math.max(1, Math.round(f * total)));
}

export { pictogramScale, sharedPictogramScale, filledOn, fillOn, oneInPhrase,
         comparePopulations, SCALES, MIN_SPREAD_DOTS };
