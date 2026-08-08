import { describe, it, expect } from "vitest";
import { parseDetails, isStrayTag, stripTags } from "./markdown-parse";

/**
 * Parsing only, no rendering — the repo's rule. A reader reported raw
 * "<details>" and "<summary>" printing as visible text inside an answer; the
 * model reaches for them because markdown has no collapsible and it wants one.
 */

describe("parseDetails", () => {
  const lines = [
    "<details>",
    "<summary><strong>CYP2C19</strong> — rs4244285 (genotype GA)</summary>",
    "**What this gene does:** Controls how quickly you break down antidepressants.",
    "Clinical significance: Moderate.",
    "</details>",
    "After the block.",
  ];

  it("pulls the summary out and strips its inline html", () => {
    expect(parseDetails(lines, 0).summary).toBe("CYP2C19 — rs4244285 (genotype GA)");
  });

  it("keeps the body and leaves the summary out of it", () => {
    const { body } = parseDetails(lines, 0);
    expect(body.join("\n")).toContain("What this gene does");
    expect(body.join("\n")).toContain("Clinical significance");
    expect(body.join("\n")).not.toContain("<summary>");
  });

  it("resumes after the closing tag rather than re-reading it", () => {
    const { endsAt } = parseDetails(lines, 0);
    expect(lines[endsAt]).toBe("After the block.");
  });

  it("survives a block that was never closed", () => {
    // Answers stream, so one can render mid-structure. Returning what was found
    // beats swallowing the rest of the answer.
    const partial = ["<details>", "<summary>Open</summary>", "Body so far"];
    const { summary, body, endsAt } = parseDetails(partial, 0);
    expect(summary).toBe("Open");
    expect(body).toEqual(["Body so far"]);
    expect(endsAt).toBe(partial.length);
  });

  it("handles a block with no summary at all", () => {
    const { summary, body } = parseDetails(["<details>", "just text", "</details>"], 0);
    expect(summary).toBe("");
    expect(body).toEqual(["just text"]);
  });
});

describe("isStrayTag", () => {
  it("catches lone tags the model improvises", () => {
    for (const line of ["<div>", "</div>", "<br>", "  <span class='x'>  ", "<hr/>"]) {
      expect(isStrayTag(line), line).toBe(true);
    }
  });

  it("leaves real content alone", () => {
    for (const line of ["Real prose.", "a < b and c > d", "## Heading", "- item",
                        "| a | b |", "**bold** text"]) {
      expect(isStrayTag(line), line).toBe(false);
    }
  });

  it("is safe on nothing", () => {
    expect(isStrayTag("")).toBe(false);
    expect(isStrayTag(null)).toBe(false);
  });
});

describe("stripTags", () => {
  it("leaves the text and removes the markup", () => {
    expect(stripTags("<strong>CYP2C19</strong> — rs123")).toBe("CYP2C19 — rs123");
  });

  it("is safe on nothing", () => {
    expect(stripTags(null)).toBe("");
    expect(stripTags("")).toBe("");
  });
});
