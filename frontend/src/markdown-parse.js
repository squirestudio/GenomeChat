/**
 * Markdown parsing that is not rendering.
 *
 * Split out of `markdown.jsx` for two reasons: it can be tested without a
 * renderer — this repo tests pure logic and deliberately avoids component tests
 * — and a `.jsx` file that exports non-components breaks fast refresh for the
 * whole tree, which lint catches.
 */

/** Remove HTML tags from a fragment, leaving the text for the markdown renderer. */
function stripTags(html) {
  return String(html || "").replace(/<[^>]*>/g, "").trim();
}

/**
 * A `<details>` block, parsed.
 *
 * The model reaches for `<details>`/`<summary>` whenever an answer has many
 * repeating parts — 23 variants, each with four lines about it — because
 * markdown has no collapsible and it wants one. Without support the tags
 * printed as literal text and the content under them looked broken, which is
 * exactly what a reader reported.
 *
 * An unterminated block is normal rather than exceptional: answers stream, so
 * one can be rendered mid-structure. Everything found so far is returned rather
 * than swallowing the rest of the answer.
 */
function parseDetails(lines, start) {
  let summary = "";
  const body = [];
  let i = start + 1;
  while (i < lines.length && !/^\s*<\/details>/i.test(lines[i])) {
    const sm = lines[i].match(/<summary>([\s\S]*?)<\/summary>/i);
    if (sm && !summary) summary = stripTags(sm[1]);
    else if (!/^\s*<\/?summary/i.test(lines[i])) body.push(lines[i]);
    i++;
  }
  return { summary, body, endsAt: Math.min(i + 1, lines.length) };
}

/**
 * A lone HTML tag the model improvised — an unclosed `<div>`, a `<br>`.
 *
 * Dropped rather than printed: a literal `<div>` in an answer reads as a bug to
 * the reader and tells them nothing.
 *
 * The optional slash before the closing bracket is for self-closing tags.
 * `<hr/>` and `<br/>` reached the reader as literal text without it, which a
 * test caught rather than a person.
 */
function isStrayTag(line) {
  return /^\s*<\/?[a-z][a-z0-9-]*(\s[^>]*)?\/?>\s*$/i.test(String(line || ""));
}

export { stripTags, parseDetails, isStrayTag };
