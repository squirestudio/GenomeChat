/**
 * Which blanks are still open in a published draft.
 *
 * The legal documents went live before every detail was settled — deliberately,
 * and with the risk accepted — so the page has to be honest about that rather
 * than rendering a literal "[MAILING ADDRESS]" and looking broken. A labelled
 * placeholder reads as a document in progress, which is what it is.
 *
 * The banner disappears by filling the blank in. It must not be possible to
 * make it disappear by editing this file, which is why the check derives from
 * the document text rather than from a flag someone can flip.
 */

/** ALL-CAPS bracketed placeholders, the convention used in `legal/`. */
const PLACEHOLDER = /\[([A-Z][A-Z\s]+)\]/g;

/** Distinct placeholder names still present in a document, in order. */
function unresolved(markdown) {
  return [...new Set([...String(markdown || "").matchAll(PLACEHOLDER)].map(m => m[1].trim()))];
}

export { unresolved, PLACEHOLDER };
