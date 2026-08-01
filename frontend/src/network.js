/**
 * Layout for the disease–phenotype network.
 *
 * A force-directed graph was the obvious choice and the wrong one: six
 * diseases with a hundred phenotypes between them settles into a hairball
 * where the only legible fact is "there are many things". The structure worth
 * seeing is which phenotypes several diseases *share*, and a bipartite layout
 * shows that directly — diseases in one column, phenotypes in another, links
 * between them.
 *
 * The backend joins HPO to ClinGen on MONDO to assemble this. Everything here
 * is arrangement.
 */

/** Frequency ordering, mirroring HPO_FREQUENCY_ORDER in the backend. */
const FREQUENCY_RANK = {
  Obligate: 0, "Very frequent": 1, Frequent: 2,
  Occasional: 3, "Very rare": 4, Excluded: 5,
};

/** How strongly a phenotype is asserted, 0–1, for line weight and opacity. */
function frequencyWeight(frequency) {
  const rank = FREQUENCY_RANK[frequency];
  if (rank === undefined) return 0.35;
  return 1 - rank * 0.16;
}

const EVIDENCE_RANK = {
  Definitive: 0, Strong: 1, Moderate: 2, Limited: 3,
  Disputed: 4, Refuted: 5, "No Reported Evidence": 6,
};

function evidenceRank(classification) {
  return EVIDENCE_RANK[classification] ?? 90;
}

/**
 * Build the bipartite graph.
 *
 * Phenotypes shared by more than one disease are the point of the whole view,
 * so they are hoisted to the top and marked. A phenotype appearing under three
 * of a gene's conditions is telling the reader something no single disease
 * page would.
 */
function buildNetwork(network, { maxPhenotypes = 22 } = {}) {
  const diseases = (network?.diseases || []).filter(d => d?.name);
  if (!diseases.length) return { diseases: [], phenotypes: [], links: [], shared: 0 };

  // Diseases keep the backend's order — curated and strongest first — so the
  // column reads top-down by how well established each link is.
  const dNodes = diseases.map((d, i) => ({
    key: d.mondo_id || d.id || d.name,
    name: d.name,
    classification: d.classification || null,
    inheritance: d.inheritance || null,
    phenotypeTotal: d.phenotype_total || (d.phenotypes || []).length,
    geneTotal: d.gene_total || 0,
    url: d.url,
    index: i,
    rank: evidenceRank(d.classification),
  }));

  // Collect phenotypes across diseases, counting how many mention each.
  const byId = new Map();
  for (const [i, d] of diseases.entries()) {
    for (const p of d.phenotypes || []) {
      if (!p?.id) continue;
      const existing = byId.get(p.id) || {
        key: p.id, name: p.name || p.id, category: p.category || null,
        diseaseIndexes: [], bestFrequency: p.frequency || null,
      };
      existing.diseaseIndexes.push(i);
      // Keep the strongest frequency any disease asserts for it.
      if ((FREQUENCY_RANK[p.frequency] ?? 9) < (FREQUENCY_RANK[existing.bestFrequency] ?? 9)) {
        existing.bestFrequency = p.frequency;
      }
      byId.set(p.id, existing);
    }
  }

  const all = [...byId.values()].map(p => ({
    ...p,
    shared: p.diseaseIndexes.length > 1,
    weight: frequencyWeight(p.bestFrequency),
  }));

  // Shared first, then by how strongly asserted. A phenotype common to several
  // of a gene's diseases is the finding; a rare one under a single disease is
  // detail, and detail loses when space runs out.
  all.sort((a, b) =>
    (b.diseaseIndexes.length - a.diseaseIndexes.length) ||
    ((FREQUENCY_RANK[a.bestFrequency] ?? 9) - (FREQUENCY_RANK[b.bestFrequency] ?? 9)) ||
    a.name.localeCompare(b.name));

  const pNodes = all.slice(0, maxPhenotypes).map((p, i) => ({ ...p, index: i }));

  const links = [];
  for (const p of pNodes) {
    for (const di of p.diseaseIndexes) {
      links.push({ disease: di, phenotype: p.index, weight: p.weight, shared: p.shared });
    }
  }

  return {
    diseases: dNodes,
    phenotypes: pNodes,
    links,
    shared: all.filter(p => p.shared).length,
    hidden: Math.max(0, all.length - pNodes.length),
  };
}

/** Colour by how well established the gene–disease link is. */
function evidenceColor(classification) {
  switch (classification) {
    case "Definitive": return "#10b981";
    case "Strong": return "#22c55e";
    case "Moderate": return "#eab308";
    case "Limited": return "#f59e0b";
    case "Disputed":
    case "Refuted": return "#ef4444";
    default: return "#64748b";
  }
}

export { buildNetwork, frequencyWeight, evidenceRank, evidenceColor, FREQUENCY_RANK };
