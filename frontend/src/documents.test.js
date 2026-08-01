import { describe, it, expect, beforeEach } from "vitest";
import {
  extractCitation, guessTitle, toPassages, makeDocument, selectPassages,
  documentsForRequest, formatCitation, saveDocsToSession, loadDocsFromSession,
  documentsSummary, PASSAGE_MIN_CHARS,
} from "./documents";

// Text taken from the paper this feature was built against: Cao et al.,
// "Novel mutations in the WNT1, TMEM38B, P4HB, and PLS3 genes in four unrelated
// Chinese families with osteogenesis imperfecta", Endocr Pract 2019;25:230-241.
const PAPER = `NOVEL MUTATIONS IN THE WNT1, TMEM38B, P4HB, AND PLS3 GENES IN FOUR UNRELATED CHINESE FAMILIES WITH OSTEOGENESIS IMPERFECTA

Objective: Osteogenesis imperfecta (OI) is a group of heritable fragile bone diseases, and the majority are caused by pathogenic variants in the COL1A1 and COL1A2 genes. We sought to identify the genetic causes of OI in Chinese patients without COL1A1 or COL1A2 mutations.

Craniofacial phenotypes and malformation of the anterior cerebellum were observed in WNT1-mutant mice; however, in the more than 20 families examined to date, only 7 individuals suffered from neurologic damage. The clinical phenotypes of WNT1 mutations ranged from moderate to severe in previous studies, and hypotonia and ataxia were the most frequently reported neural symptoms.

TMEM38B encodes trimeric intracellular cation channel type B, a K+ channel that is expressed in the endoplasmic reticulum of most tissues and synchronizes with inositol trisphosphate-mediated calcium release.

DOI: 10.4158/EP-2018-0443
Copyright 2019 AACE`;

describe("extractCitation", () => {
  it("finds the DOI, which is the part that can safely outlive the session", () => {
    expect(extractCitation(PAPER).doi).toBe("10.4158/EP-2018-0443");
  });

  it("finds a PMID and a year", () => {
    const c = extractCitation("Some paper. PMID: 30720339. Published 2019.");
    expect(c.pmid).toBe("30720339");
    expect(c.year).toBe("2019");
  });

  it("does not swallow trailing punctuation into the DOI", () => {
    expect(extractCitation("see doi 10.1038/nature12373.").doi).toBe("10.1038/nature12373");
  });

  it("returns nulls rather than throwing on nothing", () => {
    expect(extractCitation("")).toEqual({ doi: null, pmid: null, year: null });
    expect(extractCitation(undefined).doi).toBeNull();
  });
});

describe("guessTitle", () => {
  it("takes the title line from a journal scan", () => {
    expect(guessTitle(PAPER)).toMatch(/^NOVEL MUTATIONS IN THE WNT1/);
  });

  it("skips section furniture", () => {
    expect(guessTitle("Abstract\nA study of collagen folding in bone disease"))
      .toBe("A study of collagen folding in bone disease");
  });

  it("falls back to the filename", () => {
    expect(guessTitle("", "cao-2019.pdf")).toBe("cao-2019.pdf");
  });
});

describe("toPassages", () => {
  it("splits on paragraphs", () => {
    expect(toPassages(PAPER).length).toBeGreaterThanOrEqual(3);
  });

  it("drops page furniture, which is what short lines usually are", () => {
    const passages = toPassages("230  ENDOCRINE PRACTICE Vol 25 No. 3\n\nCopyright 2019\n\n" +
      "A".repeat(PASSAGE_MIN_CHARS + 10));
    expect(passages).toHaveLength(1);
  });

  it("breaks an over-long paragraph on sentences so it cannot eat the budget", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about collagen folding.`).join(" ");
    const passages = toPassages(long);
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) expect(p.length).toBeLessThanOrEqual(950);
  });

  it("is safe on nothing", () => {
    expect(toPassages("")).toEqual([]);
    expect(toPassages(null)).toEqual([]);
  });
});

describe("selectPassages", () => {
  const doc = makeDocument({ text: PAPER, name: "cao-2019.pdf" });

  it("finds the passage that answers the question", () => {
    const [picked] = selectPassages([doc], "what does WNT1 have to do with hypotonia");
    expect(picked.selected.join(" ")).toContain("hypotonia and ataxia");
  });

  it("scores gene symbols above ordinary words", () => {
    const [picked] = selectPassages([doc], "TMEM38B", null, 1);
    expect(picked.selected[0]).toContain("TMEM38B");
  });

  it("uses the gene under discussion when the question does not name it", () => {
    const [picked] = selectPassages([doc], "what does this paper say", "TMEM38B", 1);
    expect(picked.selected[0]).toContain("TMEM38B");
  });

  it("falls back to opening passages rather than sending nothing", () => {
    const [picked] = selectPassages([doc], "zzzz nothing matches this");
    expect(picked.selected.length).toBeGreaterThan(0);
  });

  it("keeps reading order within a document", () => {
    const [picked] = selectPassages([doc], "osteogenesis WNT1 TMEM38B hypotonia");
    const positions = picked.selected.map(t => doc.passages.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("respects the budget across several documents", () => {
    const other = makeDocument({ text: PAPER, name: "second.pdf" });
    const picked = selectPassages([doc, other], "WNT1 hypotonia ataxia collagen", null, 2);
    expect(picked.reduce((n, d) => n + d.selected.length, 0)).toBeLessThanOrEqual(2);
  });

  it("is safe on nothing", () => {
    expect(selectPassages([], "anything")).toEqual([]);
    expect(selectPassages(null, "anything")).toEqual([]);
  });
});

describe("documentsForRequest", () => {
  const doc = makeDocument({ text: PAPER, name: "cao-2019.pdf" });

  it("sends only title, citation and passages — never the whole document", () => {
    const [payload] = documentsForRequest([doc], "hypotonia");
    expect(Object.keys(payload).sort()).toEqual(["citation", "passages", "title"]);
  });

  it("carries the DOI so the answer can attribute the claim", () => {
    expect(documentsForRequest([doc], "hypotonia")[0].citation).toContain("10.4158/EP-2018-0443");
  });

  it("is null when there is nothing to send, so the field is simply absent", () => {
    expect(documentsForRequest([], "hypotonia")).toBeNull();
    expect(documentsForRequest(null, "hypotonia")).toBeNull();
  });
});

describe("formatCitation", () => {
  it("prefers identifiers, falling back to the filename", () => {
    expect(formatCitation({ year: "2019", doi: "10.1/x" })).toBe("2019 · doi:10.1/x");
    expect(formatCitation({}, "scan.heic")).toBe("scan.heic");
  });
});

describe("session storage", () => {
  // This suite runs in node with no DOM, by design — the rest of the frontend
  // tests cover pure logic for exactly that reason. A ten-line stub is a better
  // trade than pulling in jsdom for three assertions.
  beforeEach(() => {
    const store = new Map();
    globalThis.sessionStorage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      clear: () => store.clear(),
    };
  });

  it("round-trips documents", () => {
    const docs = [makeDocument({ text: PAPER, name: "a.pdf" })];
    saveDocsToSession(docs);
    expect(loadDocsFromSession()[0].title).toBe(docs[0].title);
  });

  it("clears on empty, so removing the last document really removes it", () => {
    saveDocsToSession([makeDocument({ text: PAPER, name: "a.pdf" })]);
    saveDocsToSession([]);
    expect(loadDocsFromSession()).toEqual([]);
  });

  it("survives corrupt storage", () => {
    sessionStorage.setItem("mydna_documents", "{not json");
    expect(loadDocsFromSession()).toEqual([]);
  });
});

describe("documentsSummary", () => {
  it("counts documents and passages", () => {
    const s = documentsSummary([makeDocument({ text: PAPER, name: "a.pdf" })]);
    expect(s.count).toBe(1);
    expect(s.label).toMatch(/^1 document · \d+ passages$/);
  });

  it("is null when nothing is loaded", () => {
    expect(documentsSummary([])).toBeNull();
  });
});

describe("makeDocument", () => {
  it("records whether the text came from a scan, which decides billing", () => {
    expect(makeDocument({ text: PAPER, name: "a.pdf" }).source).toBe("pdf");
    expect(makeDocument({ text: PAPER, name: "a.heic", source: "image" }).source).toBe("image");
  });
});
