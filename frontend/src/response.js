/**
 * Shaping an answer for the reader.
 *
 * Two decisions live here and both are worth pinning down: how the model's
 * markdown is split so the 3D structure can sit between Overview and Key
 * Findings, and which of the follow-on datasets cost a credit. The second is a
 * billing decision expressed as a UI list, so a mistake in it either
 * double-charges someone or gives away work.
 */

/** Split the model's markdown on "## " headings so the answer can be
 *  interleaved with visuals rather than dumped as one block. */
function splitProseSections(md) {
  if (!md) return { lead: "", sections: [] };
  const lines = md.split("\n");
  const out = [];
  let lead = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { title: m[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      lead.push(line);
    }
  }
  if (cur) out.push(cur);
  return {
    lead: lead.join("\n").trim(),
    sections: out.map(sx => ({ title: sx.title, body: sx.body.join("\n").trim() })),
  };
}

const norm = t => (t || "").toLowerCase().replace(/[^a-z]/g, "");
// Shown inline, in this order, before the reader chooses anything.
const PROSE_PRIMARY = ["overview", "keyfindings"];


// Labels for sections, used when reporting one that came back empty.
/* Both lists mirror OPTIONAL_SECTIONS in the backend's genomics_api_real.py.
   Adding a section there means adding it to both of these: a key missing from
   EXPLORE_LABELS is reported to the reader by its raw name, and one missing
   from ALL_SECTION_KEYS never renders at all on an unstaged response. */
const EXPLORE_LABELS = {
  pathways: "Biological pathways", expression: "Tissue expression",
  interactions: "Protein interactions", drugs: "Drugs & clinical trials",
  omim: "OMIM disease entries", pharmgkb: "Pharmacogenomics",
  cancer_mutations: "Somatic cancer mutations", clingen: "ClinGen validity",
  publication_timeline: "Publication trend", gwas: "GWAS associations",
  phenotypes: "Phenotypes", structural_variants: "Structural variants",
  genetic_tests: "Available clinical tests", medgen: "Linked conditions",
  full_text: "Full-text papers",
};

const ALL_SECTION_KEYS = ["variants", "domainmap", "popfreq", "pathways", "expression", "interactions",
  "drugs", "omim", "pharmgkb", "cancer_mutations", "clingen", "gwas", "phenotypes", "publication_timeline",
  "structural_variants", "genetic_tests", "medgen", "full_text"];

/** Everything the reader can open, in one list. Items already in hand cost
 *  nothing; the rest are fetched on demand and consume a credit. */
function buildExploreItems(msg) {
  const d = msg.data || {};
  const items = [];

  // Prose the model already wrote — free and instant.
  const { sections } = splitProseSections(msg.content);
  for (const sx of sections) {
    if (PROSE_PRIMARY.includes(norm(sx.title))) continue;
    items.push({ key: `prose:${sx.title}`, label: sx.title, source: "In this answer", instant: true });
  }

  // Data fetched with the core response — also free.
  if ((d.variants || []).length) {
    items.push({ key: "variants", label: `${d.variants.length} clinical variants`, source: "ClinVar", instant: true });
  }
  if (d.protein_info?.length && (d.variants || []).length) {
    items.push({ key: "domainmap", label: "Variant domain map", source: "UniProt / ClinVar", instant: true });
  }
  if ((d.population_summary || []).length) {
    items.push({ key: "popfreq", label: "Population frequencies", source: "gnomAD", instant: true });
  }

  // Not yet fetched.
  for (const p of d.pending_sections || []) {
    // Disease answers offer follow-up questions rather than datasets: the useful
    // next step from a gene list is reading about one of the genes, which runs
    // the whole gene pipeline through the path that already exists.
    items.push({ key: p.key, label: p.label, source: p.source, instant: false, ask: p.ask });
  }
  return items;
}
export { splitProseSections, norm, PROSE_PRIMARY, EXPLORE_LABELS, ALL_SECTION_KEYS, buildExploreItems };
