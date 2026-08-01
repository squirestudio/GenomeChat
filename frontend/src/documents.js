/**
 * The reader's own literature.
 *
 * Someone researching their own condition arrives with papers, and the useful
 * thing MyDNA can do is read them alongside the databases and the reader's own
 * genome. Everything here follows the DNA invariant exactly, because the
 * reasons are the same and stronger: documents live in sessionStorage, ride
 * along in `personal_documents` per request, and are never written to the
 * database.
 *
 * Three distinct reasons, worth keeping straight because they fail differently:
 *
 *   privacy    Uploading a paper about osteogenesis imperfecta discloses a
 *              suspected diagnosis. That is health data in its own right, and
 *              arguably more revealing than the variants — a genome needs
 *              interpretation, "I am reading about OI" does not.
 *   copyright  MyDNA has no licence to hold a publisher's text. It does not
 *              need one to help someone read their own lawful copy, and it
 *              would need one to keep a copy. So it keeps none.
 *   honesty    The upload notice promises nothing is stored. Persisting any of
 *              this would make that notice false.
 *
 * A page of a journal is far too long to send whole on every turn — the same
 * problem as a 600,000-variant file — so `selectPassages` picks by evidence of
 * relevance rather than by document order. See `selectRelevantVariants` in
 * dna.js, which this deliberately mirrors.
 */

const SESSION_KEY = "mydna_documents";

/** Roughly a page and a half of text across all documents, per request. */
const PASSAGE_BUDGET = 24;
const PASSAGE_MIN_CHARS = 60;
const PASSAGE_MAX_CHARS = 900;

/** Words too common in genetics writing to signal relevance on their own. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "were", "are",
  "have", "has", "had", "not", "but", "all", "can", "may", "which", "what",
  "who", "how", "why", "when", "does", "did", "you", "your", "our", "their",
  "gene", "genes", "genetic", "variant", "variants", "mutation", "mutations",
  "patient", "patients", "study", "studies", "gwas", "dna", "gnas",
]);

/**
 * A DOI or PubMed ID lifted out of the text.
 *
 * This is the part of an uploaded paper that can safely outlive the session and
 * be shared: an identifier is a fact, not the publisher's expression, and it
 * points at records MyDNA already has the right to fetch through PubMed and
 * PMC. Nothing here does that yet — but extracting it is what makes it possible
 * later without ever copying the article itself.
 */
function extractCitation(text) {
  const s = String(text || "");
  const doi = s.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i);
  const pmid = s.match(/\bPMID:?\s*(\d{6,8})\b/i);
  const year = s.match(/\b(19|20)\d{2}\b/);
  return {
    doi: doi ? doi[0].replace(/[.,;)]+$/, "") : null,
    pmid: pmid ? pmid[1] : null,
    year: year ? year[0] : null,
  };
}

/**
 * A human-readable title, guessed from the first substantial line.
 *
 * Only ever a label in the UI and a heading in the prompt, so a wrong guess is
 * cosmetic. The reader can rename it.
 */
function guessTitle(text, fallback = "Untitled document") {
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (line.length < 12 || line.length > 200) continue;
    if (/^(abstract|introduction|methods|results|conclusion|copyright|original article)\b/i.test(line)) continue;
    if (!/[a-z]/.test(line)) {
      // An ALL-CAPS line of reasonable length is usually the title in a journal
      // scan, so title-case it rather than shouting in the sidebar.
      return line.replace(/\s+/g, " ").slice(0, 160);
    }
    return line.replace(/\s+/g, " ").slice(0, 160);
  }
  return fallback;
}

/**
 * Split extracted text into passages a model can be handed one at a time.
 *
 * Paragraph-first, because a paragraph is the unit that carries a complete
 * claim. Over-long paragraphs are split on sentence boundaries so a single
 * dense methods section cannot eat the whole budget; fragments shorter than
 * `PASSAGE_MIN_CHARS` are dropped, since page furniture (running heads, page
 * numbers, "Copyright © 2019 AACE") is mostly short lines and carries nothing.
 */
function toPassages(text) {
  const paragraphs = String(text || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n+/)
    .map(p => p.replace(/\s+/g, " ").trim())
    .filter(p => p.length >= PASSAGE_MIN_CHARS);

  const out = [];
  for (const p of paragraphs) {
    if (p.length <= PASSAGE_MAX_CHARS) {
      out.push(p);
      continue;
    }
    let buf = "";
    for (const sentence of p.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [p]) {
      if ((buf + sentence).length > PASSAGE_MAX_CHARS && buf) {
        out.push(buf.trim());
        buf = "";
      }
      buf += sentence;
    }
    if (buf.trim().length >= PASSAGE_MIN_CHARS) out.push(buf.trim());
  }
  return out;
}

/** Build the in-memory record for one uploaded document. */
function makeDocument({ text, name, source = "pdf" }) {
  const passages = toPassages(text);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: guessTitle(text, name || "Untitled document"),
    fileName: name || "",
    source,                        // "pdf" | "image" — decides whether it cost a credit
    citation: extractCitation(text),
    passages,
    charCount: passages.reduce((n, p) => n + p.length, 0),
  };
}

/** Terms worth matching on, from a question and the gene under discussion. */
function queryTerms(message, gene) {
  const terms = new Set();
  for (const raw of String(message || "").toLowerCase().match(/[a-z0-9.]{3,}/g) || []) {
    if (!STOPWORDS.has(raw)) terms.add(raw);
  }
  // Gene symbols and rsIDs are the highest-signal tokens in the question and
  // are frequently the only thing tying a paper to the answer.
  for (const sym of String(message || "").match(/\b[A-Z][A-Z0-9]{1,7}\d?\b|rs\d+/g) || []) {
    terms.add(sym.toLowerCase());
  }
  if (gene) terms.add(String(gene).toLowerCase());
  return terms;
}

/** How well one passage answers the question. */
function scorePassage(passage, terms) {
  const lower = passage.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!lower.includes(t)) continue;
    // A gene symbol or rsID is worth much more than an ordinary word: it is an
    // assertion that this passage is about the thing being asked about.
    score += /^rs\d+$/.test(t) ? 5 : (t.length > 6 ? 3 : 1);
  }
  return score;
}

/**
 * Which passages to send, given what was asked.
 *
 * Scored passages first, across all documents, so a single relevant paragraph
 * in the second paper beats four irrelevant ones in the first. When nothing
 * matches — a general question, or a first turn — the opening passages of each
 * document are sent instead, because an abstract is where a paper says what it
 * is, and sending nothing would make the upload look broken.
 */
function selectPassages(documents, message = "", gene = null, budget = PASSAGE_BUDGET) {
  if (!documents || !documents.length) return [];
  const terms = queryTerms(message, gene);

  const scored = [];
  for (const doc of documents) {
    (doc.passages || []).forEach((text, i) => {
      scored.push({ docId: doc.id, i, text, score: scorePassage(text, terms) });
    });
  }

  const hits = scored.filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, budget);

  const chosen = hits.length ? hits : openingPassages(documents, budget);
  const byDoc = new Map();
  for (const p of chosen) {
    if (!byDoc.has(p.docId)) byDoc.set(p.docId, []);
    byDoc.get(p.docId).push(p);
  }

  // Restore reading order within each document — a model handed a paper's
  // paragraphs shuffled by score will narrate them in that order.
  return documents
    .filter(d => byDoc.has(d.id))
    .map(d => ({
      ...d,
      selected: byDoc.get(d.id).sort((a, b) => a.i - b.i).map(p => p.text),
    }));
}

/** The first passages of each document, shared out evenly. */
function openingPassages(documents, budget) {
  const per = Math.max(1, Math.floor(budget / documents.length));
  const out = [];
  for (const doc of documents) {
    (doc.passages || []).slice(0, per).forEach((text, i) => {
      out.push({ docId: doc.id, i, text, score: 0 });
    });
  }
  return out.slice(0, budget);
}

/** The `personal_documents` payload for one request. */
function documentsForRequest(documents, message = "", gene = null) {
  const picked = selectPassages(documents, message, gene);
  if (!picked.length) return null;
  return picked.map(d => ({
    title: d.title,
    citation: formatCitation(d.citation, d.fileName),
    passages: d.selected,
  }));
}

/** A short source line for the prompt and the UI. */
function formatCitation(citation, fileName = "") {
  const c = citation || {};
  const bits = [];
  if (c.year) bits.push(c.year);
  if (c.doi) bits.push(`doi:${c.doi}`);
  if (c.pmid) bits.push(`PMID:${c.pmid}`);
  if (!bits.length && fileName) return fileName;
  return bits.join(" · ");
}

/**
 * Session-scoped storage. sessionStorage, not localStorage, on purpose: closing
 * the tab must actually discard the documents, which is what the upload notice
 * promises.
 */
function saveDocsToSession(documents) {
  try {
    if (!documents || !documents.length) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, JSON.stringify(documents));
  } catch {
    // A full or disabled sessionStorage must not break the upload — the
    // documents still work for this page's lifetime, held in React state.
  }
}

function loadDocsFromSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** One-line summary for the sidebar. */
function documentsSummary(documents) {
  if (!documents || !documents.length) return null;
  const passages = documents.reduce((n, d) => n + (d.passages || []).length, 0);
  return {
    count: documents.length,
    passages,
    label: `${documents.length} document${documents.length === 1 ? "" : "s"} · ${passages} passages`,
  };
}

export {
  SESSION_KEY, PASSAGE_BUDGET, PASSAGE_MIN_CHARS, PASSAGE_MAX_CHARS,
  extractCitation, guessTitle, toPassages, makeDocument, selectPassages,
  documentsForRequest, formatCitation, saveDocsToSession, loadDocsFromSession,
  documentsSummary, scorePassage, queryTerms,
};
