/**
 * Where a reader's genotyped positions actually sit on their chromosomes.
 *
 * Everything else in MyDNA is gene-level or protein-level. This is the only view
 * that shows a genome as a genome, and it earns its place by telling a truth
 * nothing else on the page does: **a consumer array reads a vanishing fraction
 * of it.** Around 600,000 to a million positions out of 3.1 billion — call it
 * two hundredths of one percent.
 *
 * That sparseness is the lesson, not a caveat on it. A reader who has just been
 * told "you carry a variant in this gene" should be able to see how little of
 * their sequence was examined to say so, and no sentence conveys that as well as
 * a picture of it.
 *
 * Coordinates are **GRCh37**, because that is what 23andMe and AncestryDNA
 * report and what `variantsInLocus` already assumes. Mixing builds here would
 * put marks in the wrong place by megabases — see the genome-build note in
 * CLAUDE.md.
 */

/** GRCh37 chromosome lengths in base pairs, and centromere position. */
const CHROMOSOMES = [
  { name: "1", length: 249250621, centromere: 125000000 },
  { name: "2", length: 243199373, centromere: 93300000 },
  { name: "3", length: 198022430, centromere: 91000000 },
  { name: "4", length: 191154276, centromere: 50400000 },
  { name: "5", length: 180915260, centromere: 48400000 },
  { name: "6", length: 171115067, centromere: 61000000 },
  { name: "7", length: 159138663, centromere: 59900000 },
  { name: "8", length: 146364022, centromere: 45600000 },
  { name: "9", length: 141213431, centromere: 49000000 },
  { name: "10", length: 135534747, centromere: 40200000 },
  { name: "11", length: 135006516, centromere: 53700000 },
  { name: "12", length: 133851895, centromere: 35800000 },
  { name: "13", length: 115169878, centromere: 17900000 },
  { name: "14", length: 107349540, centromere: 17600000 },
  { name: "15", length: 102531392, centromere: 19000000 },
  { name: "16", length: 90354753, centromere: 36600000 },
  { name: "17", length: 81195210, centromere: 24000000 },
  { name: "18", length: 78077248, centromere: 17200000 },
  { name: "19", length: 59128983, centromere: 26500000 },
  { name: "20", length: 63025520, centromere: 27500000 },
  { name: "21", length: 48129895, centromere: 13200000 },
  { name: "22", length: 51304566, centromere: 14700000 },
  { name: "X", length: 155270560, centromere: 60600000 },
  { name: "Y", length: 59373566, centromere: 12500000 },
];

const CHROM_BY_NAME = new Map(CHROMOSOMES.map(c => [c.name, c]));

/** The haploid human genome, for the "how much did we actually read" figure. */
const GENOME_LENGTH = CHROMOSOMES
  .filter(c => c.name !== "Y")
  .reduce((n, c) => n + c.length, 0);

/** Normalise the many ways a file writes a chromosome name. */
function normaliseChrom(value) {
  let s = String(value ?? "").trim().toUpperCase();
  if (s.startsWith("CHR")) s = s.slice(3);
  if (s === "23") return "X";
  if (s === "24") return "Y";
  if (s === "25" || s === "XY") return "X";   // pseudoautosomal, reported both ways
  if (s === "26" || s === "MT" || s === "M") return "MT";
  return s;
}

/**
 * Count a reader's genotyped positions into fixed-width bins per chromosome.
 *
 * Binned rather than drawn per-variant for a reason that is not only
 * performance: at genome scale a million individual marks is a solid black bar,
 * which hides exactly the unevenness worth seeing. Array coverage is clumpy —
 * dense where the chip targets known variants, empty across centromeres and
 * repeat regions — and bins make that visible.
 *
 * Mitochondrial calls are counted separately rather than dropped: they are real
 * data, they are not on any of the 24 nuclear chromosomes, and silently
 * discarding them would make the totals disagree with the file.
 */
function binVariants(dnaData, binSize = 2_000_000) {
  const bins = new Map();      // chrom -> Int32Array
  let placed = 0, mitochondrial = 0, unplaced = 0;

  for (const c of CHROMOSOMES) {
    bins.set(c.name, new Int32Array(Math.ceil(c.length / binSize)));
  }

  const variants = dnaData?.variants;
  if (variants) {
    for (const v of variants.values()) {
      const chrom = normaliseChrom(v?.chromosome);
      const pos = Number(v?.position);
      if (chrom === "MT") { mitochondrial++; continue; }
      const meta = CHROM_BY_NAME.get(chrom);
      if (!meta || !Number.isFinite(pos) || pos < 1) { unplaced++; continue; }
      const arr = bins.get(chrom);
      const idx = Math.min(arr.length - 1, Math.floor((pos - 1) / binSize));
      arr[idx] += 1;
      placed++;
    }
  }

  let busiest = 0;
  for (const arr of bins.values()) {
    for (const n of arr) if (n > busiest) busiest = n;
  }

  return { bins, binSize, placed, mitochondrial, unplaced, busiest };
}

/**
 * The share of the genome a file actually covers, as a fraction.
 *
 * One genotyped position is one base read, so this is deliberately literal
 * rather than generous: a chip that reads 900,000 positions has looked at
 * 900,000 of 3.1 billion bases. It is a small number and it should look small.
 */
function coverageFraction(placed) {
  const n = Number(placed);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / GENOME_LENGTH;
}

/** "1 base in every 3,400" — the readable form of that fraction. */
function coveragePhrase(placed) {
  const f = coverageFraction(placed);
  if (!f) return null;
  return `about 1 base in every ${Math.round(1 / f).toLocaleString()}`;
}

/** Which chromosome and bin a gene locus falls in, for highlighting it. */
function locusBin(locus, binSize = 2_000_000) {
  const chrom = normaliseChrom(locus?.chromosome);
  const meta = CHROM_BY_NAME.get(chrom);
  const start = Number(locus?.start);
  const end = Number(locus?.end);
  if (!meta || !Number.isFinite(start)) return null;
  const from = Math.floor((start - 1) / binSize);
  const to = Number.isFinite(end) ? Math.floor((end - 1) / binSize) : from;
  return { chromosome: chrom, from, to: Math.max(from, to), start, end };
}

export {
  CHROMOSOMES, CHROM_BY_NAME, GENOME_LENGTH, normaliseChrom,
  binVariants, coverageFraction, coveragePhrase, locusBin,
};
