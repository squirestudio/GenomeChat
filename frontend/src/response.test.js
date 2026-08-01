import { describe, it, expect } from "vitest";
import { splitProseSections, buildExploreItems, EXPLORE_LABELS, ALL_SECTION_KEYS, groupExploreItems, groupFor, SECTION_GROUP, proseLayout, noResultsFor } from "./response";

describe("splitProseSections", () => {
  const answer = [
    "Some text before any heading.",
    "",
    "## Overview",
    "BRCA1 is a tumour suppressor.",
    "",
    "## Key Findings",
    "- 20 variants",
    "",
    "## Clinical Significance",
    "Pathogenic variants confer risk.",
  ].join("\n");

  it("keeps text that arrives before the first heading", () => {
    expect(splitProseSections(answer).lead).toBe("Some text before any heading.");
  });

  it("splits on the model's own headings, in order", () => {
    expect(splitProseSections(answer).sections.map(s => s.title))
      .toEqual(["Overview", "Key Findings", "Clinical Significance"]);
  });

  it("keeps each section's body with it", () => {
    const [overview] = splitProseSections(answer).sections;
    expect(overview.body).toBe("BRCA1 is a tumour suppressor.");
  });

  it("treats an answer with no headings as all lead", () => {
    const plain = splitProseSections("Just a sentence.");
    expect(plain.sections).toEqual([]);
    expect(plain.lead).toBe("Just a sentence.");
  });

  it("handles a partial answer mid-stream", () => {
    const partial = splitProseSections("## Overview\nBRCA1 is a tum");
    expect(partial.sections[0].body).toBe("BRCA1 is a tum");
  });

  it("is safe on empty or missing content", () => {
    expect(splitProseSections("").sections).toEqual([]);
    expect(splitProseSections(undefined).sections).toEqual([]);
  });

  it("does not split on ### subheadings", () => {
    const nested = splitProseSections("## Overview\n### Detail\ntext");
    expect(nested.sections).toHaveLength(1);
    expect(nested.sections[0].body).toContain("### Detail");
  });
});

describe("buildExploreItems", () => {
  const msg = {
    content: [
      "## Overview", "o",
      "## Key Findings", "k",
      "## Clinical Significance", "c",
      "## Population Genetics", "p",
    ].join("\n"),
    data: {
      variants: [{ variant_id: "VCV1" }, { variant_id: "VCV2" }],
      protein_info: { length: 1863 },
      population_summary: [{ population: "AFR" }],
      pending_sections: [
        { key: "pathways", label: "Biological pathways", source: "Reactome" },
        { key: "gwas", label: "GWAS trait associations", source: "GWAS Catalog" },
      ],
    },
  };

  it("offers the prose the model already wrote, free", () => {
    const prose = buildExploreItems(msg).filter(i => i.key.startsWith("prose:"));
    expect(prose.map(i => i.label)).toEqual(["Clinical Significance", "Population Genetics"]);
    expect(prose.every(i => i.instant)).toBe(true);
  });

  it("does not re-offer Overview or Key Findings, which are shown up front", () => {
    const titles = buildExploreItems(msg).map(i => i.label);
    expect(titles).not.toContain("Overview");
    expect(titles).not.toContain("Key Findings");
  });

  it("offers data fetched with the core response, also free", () => {
    const items = buildExploreItems(msg);
    const variants = items.find(i => i.key === "variants");
    expect(variants.label).toBe("2 clinical variants");
    expect(variants.instant).toBe(true);
    expect(items.find(i => i.key === "popfreq").instant).toBe(true);
  });

  it("marks not-yet-fetched sections as costing something", () => {
    const remote = buildExploreItems(msg).filter(i => !i.instant);
    expect(remote.map(i => i.key)).toEqual(["pathways", "gwas"]);
  });

  it("charges for nothing the reader has already paid for", () => {
    /* Prose and core data were produced by the query itself; charging to reveal
       them would be billing twice for one piece of work. */
    const free = buildExploreItems(msg).filter(i => i.instant).map(i => i.key);
    expect(free).toEqual(
      expect.arrayContaining(["prose:Clinical Significance", "variants", "domainmap", "popfreq"]),
    );
  });

  it("omits panels whose data is absent", () => {
    const bare = buildExploreItems({ content: "", data: { pending_sections: [] } });
    expect(bare).toEqual([]);
  });

  it("omits the domain map without protein length", () => {
    const noProtein = { ...msg, data: { ...msg.data, protein_info: null } };
    expect(buildExploreItems(noProtein).find(i => i.key === "domainmap")).toBeUndefined();
  });
});

describe("section registries stay in step", () => {
  /* These two lists mirror OPTIONAL_SECTIONS in the backend. Drift is quiet in
     both directions — a raw key shown to the reader, or a panel that never
     renders on an unstaged response — so it is worth asserting rather than
     remembering. */
  it("names every section it can render", () => {
    const unnamed = ALL_SECTION_KEYS.filter(
      k => !EXPLORE_LABELS[k] && !["variants", "domainmap", "popfreq"].includes(k),
    );
    expect(unnamed).toEqual([]);
  });

  it("can render every section it names", () => {
    const unrenderable = Object.keys(EXPLORE_LABELS).filter(k => !ALL_SECTION_KEYS.includes(k));
    expect(unrenderable).toEqual([]);
  });

  it("carries the sources added from NCBI", () => {
    for (const k of ["structural_variants", "genetic_tests", "medgen", "full_text"]) {
      expect(EXPLORE_LABELS[k]).toBeTruthy();
      expect(ALL_SECTION_KEYS).toContain(k);
    }
  });
});

describe("grouping the Explore further cards", () => {
  /* Nineteen ungrouped cards is a wall, and grouping is by the question a
     reader is asking rather than by which institution answers it. */
  it("puts a clinical question under the clinical heading", () => {
    expect(groupFor({ key: "disease_network" })).toBe("clinical");
    expect(groupFor({ key: "genetic_tests" })).toBe("clinical");
    expect(groupFor({ key: "structural_variants" })).toBe("clinical");
  });

  it("separates mechanism from treatment from evidence", () => {
    expect(groupFor({ key: "pathways" })).toBe("mechanism");
    expect(groupFor({ key: "drugs" })).toBe("treatment");
    expect(groupFor({ key: "pharmgkb" })).toBe("treatment");
    expect(groupFor({ key: "full_text" })).toBe("evidence");
  });

  it("treats prose the model already wrote as part of the answer", () => {
    expect(groupFor({ key: "prose:Clinical Significance" })).toBe("answer");
    expect(groupFor({ key: "variants" })).toBe("answer");
  });

  it("files an unrecognised section rather than losing it", () => {
    /* A section added to the backend but not to SECTION_GROUP must still
       reach the reader — silently disappearing is the worse failure. */
    expect(groupFor({ key: "something_new" })).toBe("evidence");
    expect(groupFor(null)).toBe("evidence");
  });

  it("every section the app can render has a group", () => {
    const ungrouped = ALL_SECTION_KEYS.filter(k => !SECTION_GROUP[k]);
    expect(ungrouped).toEqual([]);
  });

  it("drops groups with nothing in them", () => {
    const groups = groupExploreItems([{ key: "pathways" }, { key: "interactions" }]);
    expect(groups.map(g => g.key)).toEqual(["mechanism"]);
  });

  it("keeps every item, and keeps their order within a group", () => {
    const items = [
      { key: "drugs" }, { key: "disease_network" }, { key: "pharmgkb" },
      { key: "clingen" }, { key: "gwas" },
    ];
    const groups = groupExploreItems(items);
    expect(groups.flatMap(g => g.items).length).toBe(items.length);
    const clinical = groups.find(g => g.key === "clinical");
    expect(clinical.items.map(i => i.key)).toEqual(["disease_network", "clingen"]);
  });

  it("orders groups from clinical consequence outward", () => {
    const groups = groupExploreItems([
      { key: "full_text" }, { key: "drugs" }, { key: "pathways" }, { key: "clingen" },
    ]);
    expect(groups.map(g => g.key)).toEqual(["clinical", "mechanism", "treatment", "evidence"]);
  });

  it("is safe on nothing", () => {
    expect(groupExploreItems([])).toEqual([]);
    expect(groupExploreItems(null)).toEqual([]);
  });
});

describe("proseLayout", () => {
  // The answer that shipped broken: a real reply, rendered as one line.
  const followup = {
    content: "# Hypotonia: Clinical Overview\n\n## Overview\nLow muscle tone.\n\n"
           + "## Causes\nCentral and peripheral.\n\n## Clinical Significance\nVaries.",
  };

  it("renders a data-less answer whole, because nothing else will show it", () => {
    expect(proseLayout(followup).mode).toBe("whole");
  });

  it("splits a pipeline answer so panels can sit between the sections", () => {
    const msg = { ...followup, data: { genes: [] } };
    const plan = proseLayout(msg);
    expect(plan.mode).toBe("split");
    expect(plan.lead).toBe("# Hypotonia: Clinical Overview");
    expect(plan.overview.body).toBe("Low muscle tone.");
  });

  it("does not lose sections it has no inline slot for — Explore further has them", () => {
    const plan = proseLayout({ ...followup, data: {} });
    expect(plan.findings).toBeNull();
    // The same message split without a menu would drop Causes and Clinical
    // Significance entirely, which is why mode is "whole" when data is absent.
    expect(proseLayout(followup).mode).toBe("whole");
  });

  it("matches section titles loosely, so 'Key Findings:' still lands inline", () => {
    const msg = { content: "## Key Findings:\nATM dominates.", data: {} };
    expect(proseLayout(msg).findings.body).toBe("ATM dominates.");
  });

  it("is safe on nothing", () => {
    expect(proseLayout(null).mode).toBe("whole");
    expect(proseLayout({}).mode).toBe("whole");
    expect(proseLayout({ content: "", data: {} }).overview).toBeNull();
  });
});

describe("noResultsFor", () => {
  it("reports a disease query that found no genes", () => {
    expect(noResultsFor({
      query_type: "disease_query", target: "asdkjhqwe syndrome", data: { genes: [] },
    })).toBe("asdkjhqwe syndrome");
  });

  it("stays quiet when genes came back", () => {
    expect(noResultsFor({
      query_type: "disease_query", target: "hypotonia", data: { genes: [{ gene_symbol: "SOD1" }] },
    })).toBeNull();
  });

  it("never fires on a gene query — no ClinVar variants is not an empty answer", () => {
    // The gene still has pathways, expression, interactions and the rest.
    expect(noResultsFor({
      query_type: "gene_query", target: "BRCA1", data: { variants: [], pathways: [1] },
    })).toBeNull();
  });

  it("stays quiet while still streaming, and on a conversational reply", () => {
    expect(noResultsFor({ query_type: "disease_query", data: { genes: [] }, streaming: true })).toBeNull();
    expect(noResultsFor({ content: "Sure — that means..." })).toBeNull();
  });

  it("is safe on nothing", () => {
    expect(noResultsFor(null)).toBeNull();
    expect(noResultsFor({})).toBeNull();
  });
});
