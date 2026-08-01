/**
 * Somatic mutation counts across cancer projects.
 *
 * Two traps in this data, both of which would produce a confident wrong chart.
 *
 * The projects are not all cancer types. CPTAC-3 is a multi-cancer
 * proteogenomics study and it tops the list for both TP53 and BRCA1 — ranking
 * it first says "this gene is most mutated in CPTAC-3", which is a statement
 * about cohort size rather than biology. Broad cohorts are marked so they can
 * be read as what they are.
 *
 * And the consequence counts are annotations, not mutations: TP53's top three
 * sum to more than its total, because one mutation is annotated against every
 * transcript it touches. Non-coding annotations dominate and say little, so
 * the coding ones are separated out.
 */

// Programmes that span several cancers, or whose name is a study rather than a
// disease. Everything else in GDC is disease-specific.
const BROAD_COHORTS = new Set(["CPTAC-3", "CPTAC-2", "GENIE", "FM-AD", "APOLLO-LUAD"]);

/** Consequences that change the protein, in the order a reader cares about. */
const CODING_CONSEQUENCES = [
  "Missense", "Nonsense", "Frameshift", "Splice Site", "Splice Region",
  "Stop Gained", "Stop Lost", "Start Lost", "Inframe Deletion", "Inframe Insertion",
  "Synonymous",
];

const isBroad = (projectId) => BROAD_COHORTS.has(String(projectId || "").toUpperCase());

/**
 * Cancer types ranked by mutation count, with bar widths relative to the top.
 *
 * Broad cohorts keep their place in the ranking — hiding them would misstate
 * the totals — but are flagged so the label can say what they are.
 */
function rankCancerTypes(cancerTypes, { limit = 12 } = {}) {
  const rows = (cancerTypes || [])
    .filter(c => Number(c?.mutation_count) > 0)
    .map(c => ({
      projectId: c.project_id,
      name: c.cancer_type || c.project_id,
      count: Number(c.mutation_count),
      broad: isBroad(c.project_id),
    }));
  if (!rows.length) return { rows: [], max: 0, specificMax: 0 };

  rows.sort((a, b) => b.count - a.count);
  const shown = rows.slice(0, limit);
  const max = shown[0].count;
  // A separate scale for disease-specific projects, so a large multi-cancer
  // cohort cannot flatten every real cancer type against the axis.
  const specific = shown.filter(r => !r.broad);
  const specificMax = specific.length ? specific[0].count : max;

  for (const r of shown) r.relative = r.count / max;
  return { rows: shown, max, specificMax, hidden: Math.max(0, rows.length - shown.length) };
}

/**
 * Split consequence annotations into the ones that alter the protein and the
 * rest.
 *
 * Reporting "Upstream Gene: 5,806" as a gene's top consequence is technically
 * true and completely uninformative — it counts annotations against
 * neighbouring transcripts. The coding set is what a reader is asking about.
 */
function splitConsequences(consequenceTypes) {
  const all = (consequenceTypes || []).filter(c => c?.type && Number(c.count) > 0);
  const coding = [];
  const other = [];
  for (const c of all) {
    const row = { type: c.type, count: Number(c.count) };
    (CODING_CONSEQUENCES.some(k => row.type.toLowerCase().includes(k.toLowerCase()))
      ? coding : other).push(row);
  }
  coding.sort((a, b) => b.count - a.count);
  other.sort((a, b) => b.count - a.count);
  const codingTotal = coding.reduce((n, c) => n + c.count, 0);
  for (const c of coding) c.share = codingTotal ? c.count / codingTotal : 0;
  return { coding, other, codingTotal };
}

export { rankCancerTypes, splitConsequences, isBroad, BROAD_COHORTS, CODING_CONSEQUENCES };
