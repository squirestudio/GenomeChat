/**
 * The one place the source list, its links and its count are written down.
 *
 * Traceability is the strongest claim MyDNA makes, so the number attached to it
 * has to be right everywhere it appears. It was not: the welcome tour told new
 * readers **23 public research databases** while `/about` listed 28 and the FAQ
 * said 28. The tour is the first thing a first-time visitor reads, so the one
 * wrong copy was the one most people saw.
 *
 * It drifted the way these always do — sources were added and the prose that
 * counted them was somewhere else. There is no way to keep four hand-written
 * numbers in step, so none of them are hand-written any more.
 *
 * **The footer number is a subtraction, and that is the subtle one.** It names a
 * few sources and links "and N more", where N is the count *minus* the named
 * ones. That produced a genuinely nasty coincidence: with 28 sources and five
 * named, "and 23 more" is correct — the same 23 the tour had wrong, meaning one
 * of the two 23s on the site was right and the other was not. Nobody was going
 * to spot that by reading.
 *
 * **Every entry carries its root URL**, so the roll-call on `/about` is
 * checkable rather than merely stated. A reader who wants to see what ClinVar
 * actually is should not have to search for it — a list of names that cannot be
 * clicked is an assertion, and the whole argument of that page is that nothing
 * here has to be taken on trust. All 28 were verified reachable on 4 Aug 2026.
 *
 * Adding a source is one line here. What still needs doing by hand, because
 * neither can import this: the privacy policy's list of databases that receive
 * the gene being asked about, and `legal/data-source-licensing.md`. Both name
 * sources rather than counting them, so they fail loudly rather than silently.
 */

/**
 * Every source a reader can be shown, in the order `/about` displays them —
 * roughly core identity first, then clinical, then mechanism, then literature.
 *
 * Links go to each project's **root**, not to a gene-specific page. The reader
 * is being invited to see who these people are, and a deep link would land them
 * mid-record with no context for the thing they clicked.
 *
 * **OMIM is deliberately absent.** It is fetched and withheld: free for academic
 * use, but commercial use needs a Johns Hopkins licence, so it is kept out of
 * the offered sections entirely. Listing it here would advertise something a
 * reader cannot reach. See `DISCONNECTED_SECTIONS` in the backend.
 */
export const SOURCES = [
  { name: "ClinVar", url: "https://www.ncbi.nlm.nih.gov/clinvar/" },
  { name: "Ensembl", url: "https://www.ensembl.org" },
  { name: "gnomAD", url: "https://gnomad.broadinstitute.org" },
  { name: "UniProt", url: "https://www.uniprot.org" },
  { name: "AlphaFold", url: "https://alphafold.ebi.ac.uk" },
  { name: "dbSNP", url: "https://www.ncbi.nlm.nih.gov/snp/" },
  { name: "dbVar", url: "https://www.ncbi.nlm.nih.gov/dbvar/" },
  { name: "ClinGen", url: "https://clinicalgenome.org" },
  { name: "MedGen", url: "https://www.ncbi.nlm.nih.gov/medgen/" },
  { name: "GTR", url: "https://www.ncbi.nlm.nih.gov/gtr/" },
  { name: "HPO", url: "https://hpo.jax.org" },
  { name: "Monarch", url: "https://monarchinitiative.org" },
  { name: "Reactome", url: "https://reactome.org" },
  { name: "GTEx", url: "https://gtexportal.org" },
  { name: "STRING", url: "https://string-db.org" },
  { name: "Open Targets", url: "https://platform.opentargets.org" },
  { name: "GWAS Catalog", url: "https://www.ebi.ac.uk/gwas/" },
  // Formerly PharmGKB. The old domain stopped resolving entirely — a DNS
  // failure, which is how it went unnoticed longest of the ten.
  { name: "ClinPGx", url: "https://www.clinpgx.org" },
  { name: "NCI GDC", url: "https://portal.gdc.cancer.gov" },
  { name: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov" },
  { name: "PMC", url: "https://pmc.ncbi.nlm.nih.gov" },
  { name: "MedlinePlus", url: "https://medlineplus.gov/genetics/" },
  { name: "PanelApp", url: "https://panelapp.genomicsengland.co.uk" },
  { name: "ClinicalTrials.gov", url: "https://clinicaltrials.gov" },
  { name: "HGNC", url: "https://www.genenames.org" },
  { name: "GenCC", url: "https://thegencc.org" },
  { name: "Orphanet", url: "https://www.orpha.net" },
  // The VEP is part of Ensembl rather than a separate site, so this is the one
  // link that is not a bare domain — its own tool page is the useful landing.
  { name: "Ensembl VEP", url: "https://www.ensembl.org/info/docs/tools/vep/index.html" },
];

/** Just the names, for prose and for the footer. */
export const SOURCE_NAMES = SOURCES.map(s => s.name);

/** The number quoted in the tour, the FAQ and anywhere else prose needs it. */
export const SOURCE_COUNT = SOURCES.length;

/**
 * The handful the footer names before linking the rest.
 *
 * Five rather than all of them because the footer is one line, and these are the
 * most recognisable — a reader who knows one genomics database knows ClinVar.
 * Every name here must exist in `SOURCES`; a test asserts it, since a typo would
 * silently inflate `FOOTER_REMAINDER` by one.
 */
export const FOOTER_NAMED = ["Ensembl", "ClinVar", "gnomAD", "MedlinePlus", "PanelApp"];

/** What "and N more" has to say to add up. Never hand-written. */
export const FOOTER_REMAINDER = SOURCE_COUNT - FOOTER_NAMED.length;
