/**
 * DNA file handling — parsing and session persistence.
 *
 * Extracted from App.jsx because it is the most self-contained concern in the
 * app: no React, no JSX, and a hard privacy boundary. Everything here runs in
 * the browser and nothing leaves it. Keeping it in one file makes that claim
 * checkable rather than something you have to trace through four thousand
 * lines of UI to believe.
 */

// ─── DNA File Parser (client-side only — never uploaded or stored) ────────────
function parseDNAFile(text) {
  const lines = text.split(/\r?\n/);
  const variants = new Map(); // rsid -> { genotype, chromosome, position }
  let format = "23andMe";

  if (lines.some(l => l.startsWith("##fileformat=VCF"))) {
    format = "VCF";
  } else {
    const header = lines.find(l => l.trim() && !l.startsWith("#"));
    if (header && (header.includes("allele1") || header.includes("allele2"))) {
      format = "AncestryDNA";
    }
  }

  if (format === "VCF") {
    for (const line of lines) {
      if (line.startsWith("#") || !line.trim()) continue;
      const cols = line.split("\t");
      if (cols.length < 9) continue;
      const [chrom, pos, id, ref, alt, , , , , ...samples] = cols;
      if (!id || id === ".") continue;
      const rsid = id.split(";").find(x => x.startsWith("rs")) || id;
      const gt = (samples[0] || "").split(":")[0] || "";
      const alleles = [ref, ...alt.split(",")];
      const indices = gt.split(/[|/]/).map(Number);
      const genotype = indices.map(i => alleles[i] || ".").join("");
      variants.set(rsid, { genotype, chromosome: chrom, position: pos });
    }
  } else if (format === "AncestryDNA") {
    for (const line of lines) {
      if (line.startsWith("#") || !line.trim()) continue;
      const cols = line.split("\t");
      if (!cols[0] || cols[0] === "rsid" || !cols[0].startsWith("rs")) continue;
      const [rsid, chromosome, position, allele1, allele2] = cols;
      variants.set(rsid, { genotype: (allele1 + allele2).replace(/0/g, ""), chromosome, position });
    }
  } else {
    // 23andMe
    for (const line of lines) {
      if (line.startsWith("#") || !line.trim()) continue;
      const cols = line.split("\t");
      if (!cols[0] || cols[0] === "rsid" || !cols[0].startsWith("rs")) continue;
      const [rsid, chromosome, position, genotype] = cols;
      variants.set(rsid, { genotype: (genotype || "").trim(), chromosome, position });
    }
  }

  return { variants, totalCount: variants.size, format };
}

// sessionStorage helpers — Map isn't JSON-serializable so we convert to/from entries
const SESSION_KEY = "genomechat_dna_session";


function saveDnaToSession(data) {
  if (!data) { sessionStorage.removeItem(SESSION_KEY); return; }
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      entries: Array.from(data.variants.entries()),
      totalCount: data.totalCount,
      format: data.format,
      filename: data.filename,
    }));
  } catch { /* quota exceeded or private mode — fail silently */ }
}

function loadDnaFromSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { entries, totalCount, format, filename } = JSON.parse(raw);
    return { variants: new Map(entries), totalCount, format, filename };
  } catch { return null; }
}

// ─── Notable Variants Lookup Table (client-side, no API needed) ──────────────
const NOTABLE_VARIANTS = [
  // Pharmacogenomics
  { rsid: "rs4244285",  gene: "CYP2C19", category: "pharmacogenomics", name: "CYP2C19*2", riskAllele: "A", desc: "Poor metabolizer — reduced activation of clopidogrel, PPIs, antidepressants" },
  { rsid: "rs4986893",  gene: "CYP2C19", category: "pharmacogenomics", name: "CYP2C19*3", riskAllele: "A", desc: "Poor metabolizer — compounded effect with *2" },
  { rsid: "rs12248560", gene: "CYP2C19", category: "pharmacogenomics", name: "CYP2C19*17", riskAllele: "T", desc: "Rapid/ultrarapid metabolizer — may need higher doses of some drugs" },
  { rsid: "rs4149056",  gene: "SLCO1B1", category: "pharmacogenomics", name: "SLCO1B1*5", riskAllele: "C", desc: "Reduced statin transport — increased risk of statin-induced myopathy" },
  { rsid: "rs1800462",  gene: "TPMT",    category: "pharmacogenomics", name: "TPMT*2",   riskAllele: "A", desc: "Poor thiopurine metabolizer — risk of severe toxicity on azathioprine" },
  { rsid: "rs1801280",  gene: "NAT2",    category: "pharmacogenomics", name: "NAT2 slow", riskAllele: "A", desc: "Slow acetylator — increased risk of adverse effects from isoniazid, dapsone" },
  { rsid: "rs1799929",  gene: "NAT2",    category: "pharmacogenomics", name: "NAT2 slow", riskAllele: "A", desc: "Slow acetylator — contributes to drug accumulation" },
  // Cardiovascular & Thrombosis
  { rsid: "rs6025",     gene: "F5",      category: "cardiovascular", name: "Factor V Leiden", riskAllele: "A", desc: "Increased blood clot risk — 5-10× higher DVT/PE risk if homozygous" },
  { rsid: "rs1799963",  gene: "F2",      category: "cardiovascular", name: "Prothrombin G20210A", riskAllele: "A", desc: "Elevated prothrombin — 3× increased venous thrombosis risk" },
  { rsid: "rs1801133",  gene: "MTHFR",   category: "cardiovascular", name: "MTHFR C677T", riskAllele: "A", desc: "Reduced folate metabolism — elevated homocysteine, cardiovascular and neural tube implications" },
  { rsid: "rs1801131",  gene: "MTHFR",   category: "cardiovascular", name: "MTHFR A1298C", riskAllele: "C", desc: "Mild folate pathway impact — compounded with C677T" },
  { rsid: "rs2228671",  gene: "LDLR",    category: "cardiovascular", name: "LDLR variant", riskAllele: "T", desc: "Familial hypercholesterolemia marker — affects LDL receptor function" },
  // Neurological & Alzheimer's
  { rsid: "rs429358",   gene: "APOE",    category: "neurological", name: "APOE ε4", riskAllele: "C", desc: "Strongest genetic risk factor for late-onset Alzheimer's — 3-4× risk per allele" },
  { rsid: "rs7412",     gene: "APOE",    category: "neurological", name: "APOE ε2", riskAllele: "T", desc: "APOE ε2 allele — associated with reduced Alzheimer's risk and longevity" },
  // Cancer Risk
  { rsid: "rs1799950",  gene: "BRCA1",   category: "cancer", name: "BRCA1 N372H", riskAllele: "G", desc: "Common BRCA1 variant — modest breast/ovarian cancer association" },
  { rsid: "rs799917",   gene: "BRCA1",   category: "cancer", name: "BRCA1 S694S", riskAllele: "T", desc: "BRCA1 synonymous variant — population screening marker" },
  { rsid: "rs1801406",  gene: "BRCA2",   category: "cancer", name: "BRCA2 N289H", riskAllele: "A", desc: "BRCA2 variant — associated with DNA repair pathway" },
  { rsid: "rs206076",   gene: "BRCA2",   category: "cancer", name: "BRCA2 K3326*", riskAllele: "A", desc: "BRCA2 truncating variant — associated with elevated cancer risk" },
  // Hereditary Conditions
  { rsid: "rs1800562",  gene: "HFE",     category: "hereditary", name: "HFE C282Y", riskAllele: "A", desc: "Primary hemochromatosis variant — iron overload if homozygous" },
  { rsid: "rs1799945",  gene: "HFE",     category: "hereditary", name: "HFE H63D", riskAllele: "C", desc: "Minor hemochromatosis variant — risk increases if compound heterozygous with C282Y" },
  // Metabolism & Nutrition
  { rsid: "rs13266634", gene: "SLC30A8", category: "metabolism", name: "SLC30A8 R325W", riskAllele: "T", desc: "Type 2 diabetes risk variant — affects zinc transport in pancreatic beta cells" },
  { rsid: "rs1801282",  gene: "PPARG",   category: "metabolism", name: "PPARG Pro12Ala", riskAllele: "G", desc: "Protective variant for type 2 diabetes — improves insulin sensitivity" },
];


/**
 * Match an uploaded file against the curated panel above.
 *
 * Lives here rather than in App.jsx because it reads NOTABLE_VARIANTS: when it
 * sat in the component it referenced a constant that had moved to this module
 * and was never exported, so it threw a ReferenceError for every reader with
 * DNA loaded. Keeping the function next to the data it depends on is what stops
 * that recurring.
 */
function computeDnaSummary(dnaData) {
  if (!dnaData) return null;
  const findings = [];
  for (const nv of NOTABLE_VARIANTS) {
    const userVariant = dnaData.variants.get(nv.rsid);
    if (!userVariant) continue;
    const genotype = userVariant.genotype || "";
    const hasRisk = genotype.includes(nv.riskAllele);
    const isHomozygous = genotype.length === 2 && genotype[0] === genotype[1];
    findings.push({ ...nv, genotype, hasRisk, isHomozygous, userVariant });
  }
  const byCategory = {};
  for (const f of findings) {
    if (!byCategory[f.category]) byCategory[f.category] = [];
    byCategory[f.category].push(f);
  }
  return { findings, byCategory, totalFound: findings.length };
}

/**
 * Which of a reader's variants sit inside a gene, by GRCh37 coordinates.
 *
 * Consumer DNA files report GRCh37, so the locus must be GRCh37 too — the
 * GRCh38 coordinates for BRCA1 are ~1.85 Mb away and would select a different
 * stretch of chromosome 17 entirely. `assembly` is checked rather than trusted
 * so a future caller cannot pass the wrong build silently.
 *
 * Runs entirely in the browser: the reader's variants are never sent anywhere
 * to work out which ones are relevant.
 */
function variantsInLocus(dnaData, locus) {
  if (!dnaData || !locus || !locus.chromosome) return [];
  if (locus.assembly && locus.assembly !== "GRCh37") return [];
  const start = Number(locus.start);
  const end = Number(locus.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  // Files write chromosomes as "17", AncestryDNA sometimes as "chr17", and the
  // sex chromosomes vary in case.
  const norm = (c) => String(c ?? "").replace(/^chr/i, "").toUpperCase();
  const target = norm(locus.chromosome);

  const hits = [];
  for (const [rsid, v] of dnaData.variants) {
    if (norm(v.chromosome) !== target) continue;
    const pos = Number(v.position);
    if (!Number.isFinite(pos) || pos < start || pos > end) continue;
    hits.push({ rsid, ...v });
  }
  hits.sort((a, b) => Number(a.position) - Number(b.position));
  return hits;
}

// Upper bound on variants sent with a question. The prompt has to stay a
// reasonable size, so what matters is that the budget is spent on the most
// relevant variants rather than on whichever ones happen to sort first.
const VARIANT_PROMPT_BUDGET = 200;

/**
 * Choose which of a reader's variants to send with a question.
 *
 * The obvious implementation — take the first 200 — is what this replaces, and
 * it was worse than it looks: these files are sorted by chromosome and
 * position, so the first 200 are always the start of chromosome 1 and were
 * therefore almost never related to whatever was being asked about. The model
 * was given a slice of someone's genome chosen by file order.
 *
 * Priority is by evidence of relevance: variants named in the question, then
 * those inside the gene being asked about, then the curated panel, then
 * whatever else fits.
 */
function selectRelevantVariants(dnaData, message = "", locus = null) {
  if (!dnaData || !dnaData.variants) return [];

  const chosen = new Map();
  const take = (rsid, v) => {
    if (!chosen.has(rsid) && chosen.size < VARIANT_PROMPT_BUDGET) {
      chosen.set(rsid, { rsid, ...v });
    }
  };

  for (const rsid of String(message).match(/rs\d+/gi) || []) {
    const key = rsid.toLowerCase();
    const v = dnaData.variants.get(key);
    if (v) take(key, v);
  }

  for (const hit of variantsInLocus(dnaData, locus)) {
    take(hit.rsid, hit);
  }

  for (const nv of NOTABLE_VARIANTS) {
    const v = dnaData.variants.get(nv.rsid);
    if (v) take(nv.rsid, v);
  }

  for (const [rsid, v] of dnaData.variants) {
    if (chosen.size >= VARIANT_PROMPT_BUDGET) break;
    take(rsid, v);
  }

  return Array.from(chosen.values());
}

export {
  parseDNAFile, saveDnaToSession, loadDnaFromSession, SESSION_KEY,
  NOTABLE_VARIANTS, computeDnaSummary, variantsInLocus, selectRelevantVariants,
  VARIANT_PROMPT_BUDGET,
};
