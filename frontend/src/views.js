/**
 * The view grammar: how an answer asks for a picture.
 *
 * The model had prose, tables and collapsibles, and nothing else. So when a
 * reader asked for an interactive genome map it improvised HTML — because from
 * where the model sits, that is the only thing resembling a UI primitive. All
 * the while the frontend already had a zoomable variant map, a karyogram, a
 * helix and a personal-variants panel that it could not name.
 *
 * A view block closes that gap:
 *
 *     ```mydna-view
 *     {"view": "karyogram"}
 *     ```
 *
 * **It names a component; it never carries data.** The frontend already holds
 * the pipeline result and the reader's DNA, so re-emitting them through the
 * model would cost tokens twice, risk transcription errors in numbers that
 * matter, and let a hallucinated value reach a chart that looks authoritative.
 * The model chooses *what to show*, never *what the values are*.
 *
 * Unknown names and unmet requirements resolve to a stated reason rather than
 * nothing, because a view that silently vanishes leaves a dangling sentence
 * above it — the model will have written "here is the map" either way.
 */

/**
 * Every view the model may ask for.
 *
 * `requires` is checked against what is actually on the page before rendering.
 * `needs` is the sentence shown when it is not, and it is written to the reader
 * rather than to a developer: they can act on "upload your DNA", not on
 * "dnaData is null".
 */
const VIEWS = {
  karyogram: {
    label: "Genome map",
    requires: ["dna"],
    needs: "Upload your DNA file to see this mapped across your chromosomes.",
    hint: "Where a reader's genotyped positions sit across all 24 chromosomes. Shows how sparse array data is.",
  },
  helix: {
    label: "Double helix",
    requires: ["dna", "locus"],
    needs: "Upload your DNA file to see your own bases in this gene.",
    hint: "The reader's own bases in one gene, drawn as a double helix with heterozygous positions ringed.",
  },
  my_variants: {
    label: "Your variants in this gene",
    requires: ["dna", "locus"],
    needs: "Upload your DNA file to see which of your variants fall in this gene.",
    hint: "Which of the reader's own variants fall inside the gene being discussed.",
  },
  variant_map: {
    label: "Variant map",
    requires: ["variants"],
    needs: "No curated variants were returned for this gene.",
    hint: "Every curated variant along the protein, coloured by significance. Zoomable and pinnable.",
  },
  expression: {
    label: "Tissue expression",
    requires: ["expression"],
    needs: "No expression data was returned for this gene.",
    hint: "Where the gene is expressed across tissues, from GTEx.",
  },
  pathways: {
    label: "Pathways",
    requires: ["pathways"],
    needs: "No pathway data was returned for this gene.",
    hint: "The Reactome pathways this gene takes part in.",
  },
  population: {
    label: "Population frequency",
    requires: ["populations"],
    needs: "No population frequency data was returned for this gene.",
    hint: "How common a variant is across ancestry groups, as a shared-scale dot grid.",
  },
};

/** The fence the model writes. */
const VIEW_FENCE = /^\s*```\s*mydna-view\s*$/i;

/**
 * Read a view block starting at `start`.
 *
 * Tolerates an unterminated fence, because answers stream and one can be
 * rendered mid-block; a half-written spec yields no view rather than eating the
 * rest of the answer.
 */
function parseViewBlock(lines, start) {
  const body = [];
  let i = start + 1;
  while (i < lines.length && !/^\s*```/.test(lines[i])) {
    body.push(lines[i]);
    i++;
  }
  const endsAt = Math.min(i + 1, lines.length);
  let spec = null;
  try {
    const parsed = JSON.parse(body.join("\n").trim() || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) spec = parsed;
  } catch { /* a spec still being streamed is not valid JSON yet */ }
  return { spec, endsAt };
}

/**
 * What to do with a spec, given what is on the page.
 *
 * Returns `{ status }` of `"render"`, `"unavailable"` or `"unknown"`. The caller
 * maps `view` onto a component; this decides only whether it can be shown, so
 * the decision is testable without React.
 */
function resolveView(spec, context = {}) {
  const name = String(spec?.view || "").trim().toLowerCase();
  if (!name) return { status: "unknown", reason: "No view named." };

  const def = VIEWS[name];
  if (!def) {
    return {
      status: "unknown",
      reason: `Unknown view "${name}".`,
      known: Object.keys(VIEWS),
    };
  }

  const missing = def.requires.filter(r => !context[r]);
  if (missing.length) {
    return { status: "unavailable", view: name, label: def.label, reason: def.needs };
  }
  return { status: "render", view: name, label: def.label, options: spec };
}

/** The catalogue, for the prompt. Kept here so it cannot drift from the code. */
function viewCatalogue() {
  return Object.entries(VIEWS).map(([name, d]) => ({
    name, label: d.label, hint: d.hint, requires: d.requires,
  }));
}

export { VIEWS, VIEW_FENCE, parseViewBlock, resolveView, viewCatalogue };
