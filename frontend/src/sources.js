/**
 * The one place the source list and its count are written down.
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
 * Adding a source is now one line here. What still needs doing by hand, because
 * neither can import this: the privacy policy's list of databases that receive
 * the gene being asked about, and `legal/data-source-licensing.md`. Both name
 * sources rather than counting them, so they fail loudly rather than silently.
 */

/**
 * Every source a reader can be shown, in the order `/about` displays them —
 * roughly core identity first, then clinical, then mechanism, then literature.
 *
 * **OMIM is deliberately absent.** It is fetched and withheld: free for academic
 * use, but commercial use needs a Johns Hopkins licence, so it is kept out of
 * the offered sections entirely. Listing it here would advertise something a
 * reader cannot reach. See `DISCONNECTED_SECTIONS` in the backend.
 */
export const SOURCES = [
  "ClinVar", "Ensembl", "gnomAD", "UniProt", "AlphaFold", "dbSNP", "dbVar",
  "ClinGen", "MedGen", "GTR", "HPO", "Monarch", "Reactome", "GTEx",
  "STRING", "Open Targets", "GWAS Catalog", "ClinPGx", "NCI GDC", "PubMed", "PMC",
  "MedlinePlus", "PanelApp", "ClinicalTrials.gov", "HGNC",
  "GenCC", "Orphanet", "Ensembl VEP",
];

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
