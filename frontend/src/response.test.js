import { describe, it, expect } from "vitest";
import { splitProseSections, buildExploreItems, EXPLORE_LABELS, ALL_SECTION_KEYS } from "./response";

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
