/**
 * The one markdown renderer.
 *
 * Shared by the chat answers and the legal pages, and shared on purpose: two
 * renderers drift, and the second one is always the one that turns out not to
 * support tables on the day someone puts a table in a privacy policy.
 *
 * Hand-rolled rather than a library because the output is inline-styled to the
 * theme tokens, and because the subset that actually appears — headings, lists,
 * tables, bold, code, links — is small and known. Parsing that needs no
 * rendering lives in `markdown-parse.js` so it can be tested on its own.
 */
import { parseTable, isNumeric } from "./table";
import { linkifyGenes } from "./genes";
import { parseDetails, isStrayTag } from "./markdown-parse";
import { VIEW_FENCE, parseViewBlock } from "./views";

/**
 * Gene symbols as buttons that put the symbol in the input box.
 *
 * Prefill rather than send: inline words are the easiest thing on the page to
 * hit by accident, especially when selecting text on a phone, and a query costs
 * a credit. Prefilling keeps the momentum without the misclick, and lets the
 * reader turn "COL1A1" into "COL1A1 pathogenic variants" before spending.
 *
 * Applied to every text run including the inside of **bold**, because the
 * explanation prompt asks for gene names in bold, so that is where most of them
 * are.
 */
function withGenes(text, key, gene) {
  if (!gene?.onPick) return text;
  const parts = linkifyGenes(text, gene.known);
  if (parts.length === 1 && typeof parts[0] === "string") return text;
  return parts.map((part, n) =>
    typeof part === "string" ? part : (
      <button
        key={`${key}-g${n}`}
        type="button"
        onClick={() => gene.onPick(part.gene)}
        title={`Ask about ${part.gene}`}
        style={{
          font: "inherit", color: "var(--accent)", background: "none",
          border: "none", borderBottom: "1px dashed rgb(var(--c-accent) / 0.45)",
          padding: 0, cursor: "pointer",
        }}
      >{part.gene}</button>
    )
  );
}

function renderInline(text, gene) {
  const parts = [];
  const re = /(\*\*(.+?)\*\*|`(.+?)`|\*(.+?)\*)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(withGenes(text.slice(last, m.index), `t${m.index}`, gene));
    if (m[2]) parts.push(<strong key={m.index} style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{withGenes(m[2], `b${m.index}`, gene)}</strong>);
    else if (m[3]) parts.push(<code key={m.index} style={{ fontFamily: "monospace", fontSize: "0.78em", background: "var(--border-solid)", color: "var(--accent-soft)", padding: "0.1em 0.35em", borderRadius: 3 }}>{m[3]}</code>);
    else if (m[4]) parts.push(<em key={m.index} style={{ color: "var(--text-muted)" }}>{withGenes(m[4], `e${m.index}`, gene)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(withGenes(text.slice(last), `t${last}`, gene));
  return parts;
}

function Markdown({ content, gene, onView }) {
  if (!content) return null;
  const lines = content.split("\n");
  const elements = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("# ")) {
      // The model opens most answers with an H1 and the renderer had no case
      // for it, so every answer began with a literal "#" on the page.
      elements.push(
        <h1 key={i} style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text)", margin: "0 0 0.5rem", lineHeight: 1.35 }}>
          {renderInline(line.slice(2), gene)}
        </h1>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h2 key={i} style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text)", margin: "1.25rem 0 0.5rem", paddingBottom: "0.375rem", borderBottom: "1px solid var(--border-solid)" }}>
          {renderInline(line.slice(3), gene)}
        </h2>
      );
    } else if (VIEW_FENCE.test(line)) {
      // The model asking for a picture. It names a component and never carries
      // data — the page already holds the pipeline result and the reader's DNA,
      // so passing values back through the model would cost tokens twice and
      // let a transcription error reach a chart that looks authoritative.
      const v = parseViewBlock(lines, i);
      i = v.endsAt;
      const node = v.spec && onView ? onView(v.spec) : null;
      if (node) elements.push(<div key={`v${i}`}>{node}</div>);
      continue;
    } else if (/^\s*<details\b/i.test(line)) {
      // **Parsed, never injected.** Only these two tags are understood and the
      // text inside goes through the normal renderer, so this adds a structure
      // the model can use without a path from model output to innerHTML.
      const d = parseDetails(lines, i);
      i = d.endsAt;
      elements.push(
        <details key={`d${i}`} className="md-details">
          <summary>{renderInline(d.summary || "Details", gene)}</summary>
          <div className="md-details-body"><Markdown content={d.body.join("\n")} gene={gene} onView={onView} /></div>
        </details>
      );
      continue;
    } else if (isStrayTag(line)) {
      i++;
      continue;
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3 key={i} style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", margin: "0.875rem 0 0.25rem" }}>
          {renderInline(line.slice(4), gene)}
        </h3>
      );
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("• "))) {
        items.push(<li key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "0.2rem" }}>{renderInline(lines[i].slice(2), gene)}</li>);
        i++;
      }
      elements.push(<ul key={`ul${i}`} style={{ paddingLeft: "1.25rem", listStyle: "disc", margin: "0.5rem 0" }}>{items}</ul>);
      continue;
    } else if (line.includes("|") && parseTable(lines, i)) {
      // Tables were reaching the reader as raw pipe characters — the renderer
      // had no support for them at all, and the model writes them whenever
      // data is genuinely tabular. Parsed in table.js, which requires a
      // delimiter row so a line of prose containing a pipe is not mistaken
      // for one.
      const t = parseTable(lines, i);
      elements.push(
        <div key={`tbl${i}`} style={{ overflowX: "auto", margin: "0.7rem 0" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.8rem" }}>
            <thead>
              <tr>
                {t.headers.map((h, c) => (
                  <th key={c} style={{
                    textAlign: t.align[c] || "left", padding: "0.35rem 0.6rem",
                    borderBottom: "1px solid rgb(var(--c-border) / 0.5)",
                    color: "var(--text-muted)", fontWeight: 700, whiteSpace: "nowrap",
                  }}>{renderInline(h, gene)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r} style={{ background: r % 2 ? "rgb(var(--c-surface) / 0.25)" : "transparent" }}>
                  {row.map((cell, c) => (
                    <td key={c} style={{
                      // Numbers right-align and share a width so columns of
                      // frequencies can be compared down the page.
                      textAlign: isNumeric(cell) ? "right" : (t.align[c] || "left"),
                      fontVariantNumeric: isNumeric(cell) ? "tabular-nums" : "normal",
                      padding: "0.35rem 0.6rem", color: "var(--text-faint)",
                      borderBottom: "1px solid rgb(var(--c-border) / 0.2)",
                      lineHeight: 1.5,
                    }}>{renderInline(cell, gene)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      i = t.endsAt;
      continue;
    } else if (/^\d+\.\s/.test(line)) {
      // Numbered lists appear in the legal pages and nowhere else, which is
      // exactly why they were missing: the renderer only ever saw chat answers.
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(<li key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "0.2rem" }}>{renderInline(lines[i].replace(/^\d+\.\s/, ""), gene)}</li>);
        i++;
      }
      elements.push(<ol key={`ol${i}`} style={{ paddingLeft: "1.35rem", listStyle: "decimal", margin: "0.5rem 0" }}>{items}</ol>);
      continue;
    } else if (line.startsWith("> ") || line.trim() === ">") {
      // Blockquotes, added when the postal address landed in the legal pages —
      // the same gap the numbered lists came from, found the same way. Without
      // a case here a quoted line renders its own "&gt;" on the page.
      //
      // Consecutive lines are kept as separate lines rather than joined into a
      // paragraph. Standard markdown's lazy continuation would fold an address
      // into one run-on line, which is wrong for the only thing quoted in these
      // documents, and CommonMark's fix (two trailing spaces) is invisible and
      // gets stripped by editors on save.
      const quoted = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i].trim() === ">")) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      elements.push(
        <blockquote key={`bq${i}`} style={{
          margin: "0.7rem 0", padding: "0.1rem 0 0.1rem 0.9rem",
          borderLeft: "2px solid rgb(var(--c-border) / 0.6)",
        }}>
          {quoted.map((q, n) => (
            <p key={n} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.6, margin: 0 }}>
              {renderInline(q, gene)}
            </p>
          ))}
        </blockquote>
      );
      continue;
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      elements.push(<hr key={i} style={{ border: "none", borderTop: "1px solid var(--border-solid)", margin: "1.5rem 0" }} />);
    } else if (line.trim() === "") {
      elements.push(<div key={i} style={{ height: "0.375rem" }} />);
    } else {
      elements.push(<p key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.7, margin: "0.25rem 0" }}>{renderInline(line, gene)}</p>);
    }
    i++;
  }
  return <div>{elements}</div>;
}

// Only the component is exported: `renderInline` is an implementation detail,
// and exporting a non-component alongside one breaks fast refresh for the file.
export { Markdown };
