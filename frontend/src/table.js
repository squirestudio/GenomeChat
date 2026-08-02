/**
 * Markdown table parsing.
 *
 * The renderer had no table support at all, so every table the model wrote —
 * and it writes them often, because they are the right shape for comparing
 * populations, variants or drugs — reached the reader as raw pipe characters.
 * That is what made the population-genetics section unreadable: not the
 * design, the absence of a parser.
 *
 * Kept separate from the component because the parsing has edge cases worth
 * pinning down, and because getting alignment or ragged rows wrong corrupts
 * data rather than merely looking untidy.
 */

/** A row of cells from one markdown line, with the outer pipes discarded. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Escaped pipes are content, not delimiters.
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
}

/** True for the `|---|:--:|` line that marks the row above as a header. */
function isDelimiter(line) {
  if (!line || !line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c.trim()));
}

/** Column alignment, from where the colons sit in the delimiter row. */
function alignments(delimiterLine) {
  return splitRow(delimiterLine).map(c => {
    const t = c.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

/**
 * Read a table starting at `start`, or return null if there isn't one.
 *
 * A table needs a header row and a delimiter beneath it. Without that second
 * line a single line of prose containing a pipe would be mistaken for a table,
 * which is a worse failure than not rendering one.
 */
/** The next non-blank line at or after `i`, or -1. */
function nextContentLine(lines, i) {
  while (i < lines.length && lines[i].trim() === "") i++;
  return i < lines.length ? i : -1;
}

function parseTable(lines, start) {
  const header = lines[start];
  if (!header || !header.includes("|")) return null;

  // Blank lines between rows are tolerated. The model writes tables both ways,
  // and a strict reading turned a perfectly good population-frequency table
  // into eight lines of raw pipe characters — the failure looked like missing
  // table support rather than a spacing difference, which is the worst kind of
  // bug to be shown as a screenshot.
  const dIdx = nextContentLine(lines, start + 1);
  if (dIdx === -1 || !isDelimiter(lines[dIdx])) return null;

  const headers = splitRow(header);
  const align = alignments(lines[dIdx]);
  const rows = [];
  let i = dIdx + 1;
  let lastRow = dIdx;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }
    // A non-blank line without a pipe ends the table — prose has resumed.
    if (!lines[i].includes("|")) break;
    const cells = splitRow(lines[i]);
    // Ragged rows are padded rather than dropped: a short row is still data,
    // and losing it silently is worse than a blank cell.
    while (cells.length < headers.length) cells.push("");
    rows.push(cells.slice(0, headers.length));
    lastRow = i;
    i++;
  }

  // Stop after the last row, not after the blank lines that followed it, so a
  // gap between the table and the next paragraph is still rendered.
  return { headers, align, rows, endsAt: lastRow + 1 };
}

/**
 * Is this cell a number, and should it be right-aligned and tabular?
 *
 * Frequencies arrive as "5.58e-04" and counts as "1,790", both of which read
 * far better right-aligned against each other than ragged-left.
 */
function isNumeric(cell) {
  const t = String(cell).trim().replace(/[,%]/g, "");
  if (!t) return false;
  return /^[-+]?\d*\.?\d+([eE][-+]?\d+)?$/.test(t);
}

export { parseTable, splitRow, isDelimiter, alignments, isNumeric };
