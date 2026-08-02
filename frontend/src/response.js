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

/* The section the model writes runnable queries into. Rendered as buttons
   rather than prose, so it must not also appear as an Explore-further card or
   the same suggestions show up twice.

   "suggestedfollowupqueries" is the old heading, kept because stored answers
   replay from `queries.results` and a reader opening a month-old chat should
   still get their suggestions. Those older ones are questions addressed to the
   reader rather than queries — the prompt was ambiguous about who was being
   asked — so `suggestedQueries` filters them out rather than offering a button
   that sends "Do you have a family history of X" to a genomics pipeline. */
const QUERY_SECTIONS = ["explorenext", "suggestedfollowupqueries"];

/** A line that MyDNA can actually look up, as opposed to a question for the
 *  reader. Anything second-person is the latter. */
function isRunnableQuery(line) {
  const s = (line || "").trim();
  if (s.length < 3 || s.length > 120) return false;
  if (/^(do|does|did|are|is|was|were|have|has|had|will|would|should|can|could)\b/i.test(s)) return false;
  if (/\b(you|your|yours|yourself)\b/i.test(s)) return false;
  return true;
}

/** The runnable queries an answer suggests, in order, de-duplicated. */
function suggestedQueries(content) {
  const { sections } = splitProseSections(content);
  const section = sections.find(sx => QUERY_SECTIONS.includes(norm(sx.title)));
  if (!section) return [];

  const seen = new Set();
  const out = [];
  for (const raw of section.body.split("\n")) {
    const line = raw
      .replace(/^\s*[-*•]\s+/, "")      // markdown bullet
      .replace(/^\s*\d+[.)]\s+/, "")    // numbered list
      .replace(/\*\*/g, "")             // the model bolds gene names everywhere
      .replace(/[.?]+$/, "")
      .trim();
    if (!isRunnableQuery(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Queries built from the answer's own data, when the model wrote none.
 *
 * "Explore next" is the last section the model writes, so it is the first
 * casualty when a long answer meets the token ceiling — the reader ends up with
 * no suggestions precisely on the richest answers, which are the ones most
 * worth following. These are derived from the pipeline result instead, so they
 * cost nothing, cannot be truncated, and are runnable by construction.
 *
 * Deliberately generic. This is a floor, not a replacement: the model's
 * suggestions read the room in a way a template cannot, and are preferred
 * whenever they exist.
 */
function fallbackQueries(msg, limit = 4) {
  const d = msg?.data || {};
  const out = [];
  const push = (q) => { if (q && !out.includes(q) && out.length < limit) out.push(q); };

  // A disease answer already carries its own follow-ups from the backend.
  for (const p of d.pending_sections || []) if (p.ask) push(p.ask);

  const gene = d.gene_info?.symbol || (msg?.query_type === "gene_query" ? msg.target : null);
  if (gene) {
    for (const dis of (d.disease_network?.diseases || []).slice(0, 2)) {
      const name = dis?.name || dis?.label;
      if (name) push(`genes associated with ${name}`);
    }
    for (const partner of (d.interactions || []).slice(0, 2)) {
      const sym = partner?.gene || partner?.symbol;
      if (sym && sym !== gene) push(`compare ${gene} and ${sym}`);
    }
    if ((d.pharmgkb || []).length) push(`${gene} pharmacogenomics`);
  }
  return out;
}

/** The answer with its query section removed, for rendering the prose. */
function withoutQuerySection(content) {
  if (!content) return content;
  const lines = String(content).split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) skipping = QUERY_SECTIONS.includes(norm(m[1]));
    if (!skipping) out.push(line);
  }
  return out.join("\n").trimEnd();
}

/**
 * How an answer's prose should be laid out.
 *
 * A pipeline answer is *split*: Overview and Key Findings render inline around
 * the protein viewer, and every other section becomes a card in Explore
 * further. That menu is what makes the split safe — the sections left out are
 * still one click away.
 *
 * An answer with no `data` has no menu, because Explore further is gated on
 * `msg.data`. Splitting it therefore did not defer the other sections, it
 * *deleted* them: a complete reply arrived from the backend and the reader saw
 * its first line. Anything the pipeline did not produce — a follow-up, a
 * definition, a query that fell to the conversational path — renders whole.
 */
function proseLayout(msg) {
  const body = withoutQuerySection(msg?.content);
  const { lead, sections } = splitProseSections(body);
  // `body` is what renders: the query section becomes buttons, so leaving it in
  // the prose would show every suggestion twice.
  if (!msg?.data) return { mode: "whole", body, lead: "", overview: null, findings: null };
  const pick = name => sections.find(sx => norm(sx.title) === name) || null;
  return { mode: "split", body, lead, overview: pick("overview"), findings: pick("keyfindings") };
}

/**
 * Whether to tell the reader outright that nothing was found.
 *
 * Only for disease answers, and only on a genuinely empty gene list. A gene
 * query returning zero ClinVar variants is *not* empty — it still carries
 * pathways, expression, interactions and the rest — so reporting "no results"
 * there would be false. A disease query with no genes has nothing behind it at
 * all, and used to render as a bare heading indistinguishable from a routing
 * failure.
 */
function noResultsFor(msg) {
  if (!msg || msg.streaming || !msg.data) return null;
  if (msg.query_type !== "disease_query") return null;
  if ((msg.data.genes || []).length > 0) return null;
  return msg.target || msg.data.disease || "that term";
}


// Labels for sections, used when reporting one that came back empty.
/* Both lists mirror OPTIONAL_SECTIONS in the backend's genomics_api_real.py.
   Adding a section there means adding it to both of these: a key missing from
   EXPLORE_LABELS is reported to the reader by its raw name, and one missing
   from ALL_SECTION_KEYS never renders at all on an unstaged response. */
/* Nineteen ungrouped cards after every query is a wall, and the good ones —
   the disease network, the variant map — get lost beside "Medical genetics
   concepts". Grouping is by the question a reader is asking, not by which
   database happens to answer it: someone wondering "what could this cause"
   should not have to know that ClinGen, dbVar and GTR are different
   institutions. Order runs from clinical consequence outward to mechanism and
   evidence, because that is roughly the order people care. */
const EXPLORE_GROUPS = [
  { key: "answer",    label: "In this answer" },
  { key: "clinical",  label: "What it means clinically" },
  { key: "mechanism", label: "How the gene works" },
  { key: "treatment", label: "Treatment & response" },
  { key: "evidence",  label: "Research & evidence" },
];

const SECTION_GROUP = {
  // Already in hand, free — variants and the maps built from them.
  variants: "answer", domainmap: "answer", popfreq: "answer",

  disease_network: "clinical", clingen: "clinical", omim: "clinical",
  phenotypes: "clinical", medgen: "clinical",
  structural_variants: "clinical", genetic_tests: "clinical",

  pathways: "mechanism", interactions: "mechanism", expression: "mechanism",

  drugs: "treatment", pharmgkb: "treatment",

  gwas: "evidence", cancer_mutations: "evidence",
  publication_timeline: "evidence", full_text: "evidence",
};

/** Which group an item belongs to. Prose the model wrote is always "answer";
 *  anything unrecognised falls to evidence rather than vanishing. */
function groupFor(item) {
  if (!item) return "evidence";
  if (String(item.key).startsWith("prose:")) return "answer";
  return SECTION_GROUP[item.key] || "evidence";
}

/** Items arranged into groups, preserving order and dropping empty groups. */
function groupExploreItems(items) {
  const byKey = new Map(EXPLORE_GROUPS.map(g => [g.key, { ...g, items: [] }]));
  for (const item of items || []) {
    (byKey.get(groupFor(item)) || byKey.get("evidence")).items.push(item);
  }
  return [...byKey.values()].filter(g => g.items.length > 0);
}

const EXPLORE_LABELS = {
  pathways: "Biological pathways", expression: "Tissue expression",
  interactions: "Protein interactions", drugs: "Drugs & clinical trials",
  omim: "OMIM disease entries", pharmgkb: "Pharmacogenomics",
  cancer_mutations: "Somatic cancer mutations", clingen: "ClinGen validity",
  publication_timeline: "Publication trend", gwas: "GWAS associations",
  phenotypes: "Phenotypes", structural_variants: "Structural variants",
  genetic_tests: "Available clinical tests", medgen: "Linked conditions",
  full_text: "Full-text papers",
  disease_network: "Diseases, phenotypes & related genes",
};

const ALL_SECTION_KEYS = ["variants", "domainmap", "pathways", "expression", "interactions",
  "drugs", "omim", "pharmgkb", "cancer_mutations", "clingen", "gwas", "phenotypes", "publication_timeline",
  "structural_variants", "genetic_tests", "medgen", "full_text", "disease_network"];

/** Everything the reader can open, in one list. Items already in hand cost
 *  nothing; the rest are fetched on demand and consume a credit. */
function buildExploreItems(msg) {
  const d = msg.data || {};
  const items = [];

  // Prose the model already wrote — free and instant.
  const { sections } = splitProseSections(msg.content);
  for (const sx of sections) {
    if (PROSE_PRIMARY.includes(norm(sx.title))) continue;
    if (QUERY_SECTIONS.includes(norm(sx.title))) continue;   // rendered as buttons
    items.push({ key: `prose:${sx.title}`, label: sx.title, source: "In this answer", instant: true });
  }

  // Data fetched with the core response — also free.
  if ((d.variants || []).length) {
    items.push({ key: "variants", label: `${d.variants.length} clinical variants`, source: "ClinVar", instant: true });
  }
  if (d.protein_info?.length && (d.variants || []).length) {
    items.push({ key: "domainmap", label: "Variant domain map", source: "UniProt / ClinVar", instant: true });
  }
  // `popfreq` is deliberately absent: the pictogram now renders inline with the
  // answer, because it is free, it needs no fetch, and it is the visualisation
  // the model's Population Genetics prose is reaching for with a markdown
  // table. Offering it as a card as well would show it twice. The SectionPanel
  // case and the SECTION_GROUP entry stay, so stored answers that recorded it
  // in `loadedOrder` still replay.

  // Not yet fetched.
  for (const p of d.pending_sections || []) {
    // Disease answers offer follow-up questions rather than datasets: the useful
    // next step from a gene list is reading about one of the genes, which runs
    // the whole gene pipeline through the path that already exists.
    items.push({ key: p.key, label: p.label, source: p.source, instant: false, ask: p.ask });
  }
  return items;
}
export {
  splitProseSections, norm, PROSE_PRIMARY, EXPLORE_LABELS, ALL_SECTION_KEYS,
  buildExploreItems, groupExploreItems, groupFor, EXPLORE_GROUPS, SECTION_GROUP,
  proseLayout, noResultsFor, suggestedQueries, withoutQuerySection,
  isRunnableQuery, QUERY_SECTIONS, fallbackQueries,
};
