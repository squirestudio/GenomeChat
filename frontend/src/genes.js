/**
 * Finding gene symbols in an answer so they can be clicked.
 *
 * Bold is *not* the signal. The explanation prompt asks for bold on "gene
 * names, population names, and key clinical terms", so treating bold as a gene
 * would offer **Pathogenic** and **East Asian** as queries beside **TMEM38B**.
 *
 * Nor is shape alone enough. Disease abbreviations wear the same clothes as
 * symbols — the no-diagnosis guard hit this from the other direction, where
 * "do I have OI" escaped a check that read uppercase tokens as gene names, and
 * DMD is genuinely both a gene and Duchenne muscular dystrophy.
 *
 * So two tiers, in descending confidence:
 *
 *   1. the token appears in this answer's own pipeline data — certain, because
 *      the databases returned it as a gene
 *   2. the token is symbol-shaped, not stoplisted, and either contains a digit
 *      or is at least four characters
 *
 * Tier 2 exists for genes that arrive in prose rather than from the pipeline —
 * COL1A1 read out of an uploaded paper, say — and the digit-or-length rule is
 * what keeps ATM, OI, MS, CF and AF out of it. ATM is a real gene and stays
 * clickable whenever the data actually contains it, which is the case that
 * matters.
 */

/** Keys under which this codebase stores a gene symbol. */
const GENE_KEYS = new Set(["gene_symbol", "symbol", "gene"]);

const SYMBOL_SHAPE = /^[A-Z][A-Z0-9]{1,8}$/;

/** Symbol-shaped tokens that are not genes. Conditions, units and jargon. */
const NOT_GENES = new Set([
  // conditions and clinical abbreviations
  "OI", "MS", "CF", "ALS", "HD", "PKU", "COPD", "IBD", "ADHD", "ASD", "CKD",
  "MI", "TIA", "UTI", "BMD", "MRI", "ECG", "IVF", "SMA",
  // data and method jargon
  "DNA", "RNA", "MRNA", "CDNA", "SNP", "SNPS", "VCF", "HGVS", "MIM", "OMIM",
  "HPO", "GWAS", "GDC", "TCGA", "NCBI", "EBI", "PMC", "PMID", "DOI", "API",
  "URL", "PDF", "CSV", "JSON", "ID", "IDS", "QC", "WES", "WGS", "NGS", "PCR",
  "AF", "AC", "AN", "OR", "CI", "SD", "SE", "UTR", "ORF", "KB", "MB", "BP",
  // ancestry labels and places
  "USA", "UK", "EU", "EEA", "AFR", "AMR", "EAS", "NFE", "SAS", "ASJ", "FIN",
  // ordinary words that fit the shape
  "THE", "AND", "NOT", "ALL", "FOR", "YOU", "ARE", "WAS", "HAS", "ONE", "TWO",
  "NEW", "SEE", "USE", "MAY", "CAN", "III", "II", "IV", "VI",
]);

/** Every gene symbol this answer's data actually contains. */
function genesInData(data) {
  const found = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (GENE_KEYS.has(key) && typeof value === "string" && SYMBOL_SHAPE.test(value)) {
        found.add(value);
      } else if (value && typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(data);
  return found;
}

/** Tier 2: shape alone, for genes the pipeline never returned. */
function looksLikeGene(token) {
  if (!SYMBOL_SHAPE.test(token) || NOT_GENES.has(token)) return false;
  return /\d/.test(token) || token.length >= 4;
}

/** Whether a token should be offered as a query. */
function isGene(token, known) {
  if (!token) return false;
  if (known && known.has(token)) return true;
  return looksLikeGene(token);
}

/**
 * Split text into plain strings and `{ gene }` markers.
 *
 * Returns an array so the caller decides how to render — this module knows
 * nothing about React, which is what makes it testable.
 */
function linkifyGenes(text, known) {
  const s = String(text ?? "");
  if (!s) return [];
  const out = [];
  let last = 0;
  // Word-boundary anchored so RBRCA1X and file names are left alone.
  const re = /\b[A-Z][A-Z0-9]{1,8}\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!isGene(m[0], known)) continue;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ gene: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length ? out : [s];
}

export { genesInData, looksLikeGene, isGene, linkifyGenes, NOT_GENES, GENE_KEYS };
