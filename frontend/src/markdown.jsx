/**
 * The one markdown renderer.
 *
 * Shared by the chat answers and the legal pages, and shared on purpose: two
 * renderers drift, and the second one is always the one that turns out not to
 * support tables on the day someone puts a table in a privacy policy.
 *
 * Hand-rolled rather than a library because the output is inline-styled to the
 * theme tokens, and because the subset that actually appears — headings, lists,
 * tables, bold, code, links — is small and known.
 */
import { parseTable, isNumeric } from "./table";

function renderInline(text) {
  const parts = [];
  const re = /(\*\*(.+?)\*\*|`(.+?)`|\*(.+?)\*)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2]) parts.push(<strong key={m.index} style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} style={{ fontFamily: "monospace", fontSize: "0.78em", background: "var(--border-solid)", color: "var(--accent-soft)", padding: "0.1em 0.35em", borderRadius: 3 }}>{m[3]}</code>);
    else if (m[4]) parts.push(<em key={m.index} style={{ color: "var(--text-muted)" }}>{m[4]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}


function Markdown({ content }) {
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
          {renderInline(line.slice(2))}
        </h1>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h2 key={i} style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text)", margin: "1.25rem 0 0.5rem", paddingBottom: "0.375rem", borderBottom: "1px solid var(--border-solid)" }}>
          {renderInline(line.slice(3))}
        </h2>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3 key={i} style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", margin: "0.875rem 0 0.25rem" }}>
          {renderInline(line.slice(4))}
        </h3>
      );
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("• "))) {
        items.push(<li key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "0.2rem" }}>{renderInline(lines[i].slice(2))}</li>);
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
                  }}>{renderInline(h)}</th>
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
                    }}>{renderInline(cell)}</td>
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
        items.push(<li key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "0.2rem" }}>{renderInline(lines[i].replace(/^\d+\.\s/, ""))}</li>);
        i++;
      }
      elements.push(<ol key={`ol${i}`} style={{ paddingLeft: "1.35rem", listStyle: "decimal", margin: "0.5rem 0" }}>{items}</ol>);
      continue;
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      elements.push(<hr key={i} style={{ border: "none", borderTop: "1px solid var(--border-solid)", margin: "1.5rem 0" }} />);
    } else if (line.trim() === "") {
      elements.push(<div key={i} style={{ height: "0.375rem" }} />);
    } else {
      elements.push(<p key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.7, margin: "0.25rem 0" }}>{renderInline(line)}</p>);
    }
    i++;
  }
  return <div>{elements}</div>;
}

// Only the component is exported: `renderInline` is an implementation detail,
// and exporting a non-component alongside one breaks fast refresh for the file.
export { Markdown };
