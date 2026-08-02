/**
 * Matching a pharmacogenomic annotation against the reader's own genotype.
 *
 * A ClinPGx clinical annotation is a table of interpretations keyed by
 * genotype: "patients with the CC genotype may have decreased response to
 * atorvastatin", "patients with the CT genotype may have increased response".
 * Which line applies to a given reader depends on what they actually carry.
 *
 * That is the one thing the external site cannot do, and it is the reason this
 * panel should not be a link out. ClinPGx can show every genotype; only MyDNA
 * knows which one is yours.
 *
 * **The matching happens here, in the browser.** The reader's genotypes are in
 * `sessionStorage` and stay there — the same rule `variantsInLocus()` follows
 * for the locus intersection. Nothing about which variants they carry is sent
 * anywhere to produce this.
 *
 * Only rsID-keyed annotations can be matched. ClinPGx reuses one field for the
 * variant, so it may instead hold star alleles ("SLCO1B1*1, *5, *15"), which
 * describe haplotypes that a genotyping array cannot resolve from single
 * positions. Those are shown without a match rather than guessed at.
 */

/** "TC" and "CT" are the same genotype; compare them in a fixed order. */
function normalizeGenotype(g) {
  const s = String(g || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return "";
  return s.split("").sort().join("");
}

/**
 * The reader's genotype at whichever rsID this annotation is keyed on.
 *
 * Returns `{ rsid, genotype }`, or null when there is no DNA loaded, the
 * annotation is not rsID-keyed, or the file simply does not cover that
 * position — which is common and not an error: consumer arrays genotype a
 * fraction of a percent of the genome.
 */
function readerGenotypeFor(annotation, dnaData) {
  const rsids = annotation?.rsids || [];
  if (!rsids.length || !dnaData?.variants) return null;
  for (const rsid of rsids) {
    const hit = dnaData.variants.get(String(rsid).toLowerCase());
    const genotype = hit?.genotype;
    // "--" means the array failed to call that position; treat as absent
    // rather than as a genotype, or the panel claims a finding from a gap.
    if (genotype && normalizeGenotype(genotype)) {
      return { rsid, genotype };
    }
  }
  return null;
}

/**
 * The allele-specific interpretation that applies to this reader, if any.
 *
 * Returns `{ rsid, genotype, phenotype, limited_evidence }` or null. A reader
 * whose genotype is not among the annotated ones gets null — the annotation
 * only covers the genotypes it covers, and inventing a nearest match would be
 * exactly the kind of overreach the rest of the app refuses.
 */
function matchedAllelePhenotype(annotation, dnaData) {
  const carried = readerGenotypeFor(annotation, dnaData);
  if (!carried) return null;
  const want = normalizeGenotype(carried.genotype);
  for (const ap of annotation.allele_phenotypes || []) {
    if (normalizeGenotype(ap.allele) === want) {
      return { ...carried, phenotype: ap.phenotype, limited_evidence: ap.limited_evidence };
    }
  }
  return null;
}

/** How many of these annotations the reader's file actually speaks to. */
function countMatches(annotations, dnaData) {
  if (!dnaData) return 0;
  return (annotations || []).reduce(
    (n, a) => n + (matchedAllelePhenotype(a, dnaData) ? 1 : 0), 0);
}

export { normalizeGenotype, readerGenotypeFor, matchedAllelePhenotype, countMatches };
