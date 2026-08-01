import { describe, it, expect } from "vitest";
import { parseTable, splitRow, isDelimiter, alignments, isNumeric } from "./table";

/* The real table from a CFTR answer, which reached the reader as raw pipes
   because the renderer had no table support at all. */
const CFTR = [
  "| Ancestry | AF | Interpretation |",
  "|----------|----|----|",
  "| **African/African Am.** | 5.58e-04 | Highest carrier frequency; 1 in ~1,790 individuals |",
  "| **Finnish** | 4.69e-04 | Second highest; 1 in ~2,133 individuals |",
  "| **East Asian** | 3.33e-04 | 1 in ~3,003 individuals |",
  "",
  "Interpretation: the ~2-fold higher carrier frequency…",
];

describe("parseTable", () => {
  it("reads a real table the model produced", () => {
    const t = parseTable(CFTR, 0);
    expect(t.headers).toEqual(["Ancestry", "AF", "Interpretation"]);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0][1]).toBe("5.58e-04");
  });

  it("stops at the blank line, leaving the prose alone", () => {
    /* endsAt is where the renderer resumes; swallowing the paragraph after a
       table would lose the interpretation, which is the useful part. */
    expect(parseTable(CFTR, 0).endsAt).toBe(5);
  });

  it("keeps inline markup for the cell renderer to handle", () => {
    expect(parseTable(CFTR, 0).rows[0][0]).toBe("**African/African Am.**");
  });

  it("refuses a single line of prose containing a pipe", () => {
    /* Without requiring the delimiter row, "use A | B" becomes a table — a
       worse failure than not rendering one. */
    expect(parseTable(["a | b is a choice", "more prose"], 0)).toBeNull();
  });

  it("refuses a header with no delimiter beneath it", () => {
    expect(parseTable(["| A | B |", "| 1 | 2 |"], 0)).toBeNull();
  });

  it("pads a ragged row rather than dropping it", () => {
    const t = parseTable(["| A | B | C |", "|---|---|---|", "| 1 | 2 |"], 0);
    expect(t.rows[0]).toEqual(["1", "2", ""]);
  });

  it("truncates a row with too many cells to the header width", () => {
    const t = parseTable(["| A | B |", "|---|---|", "| 1 | 2 | 3 |"], 0);
    expect(t.rows[0]).toEqual(["1", "2"]);
  });

  it("handles a table with no body rows", () => {
    const t = parseTable(["| A | B |", "|---|---|"], 0);
    expect(t.headers).toEqual(["A", "B"]);
    expect(t.rows).toEqual([]);
  });

  it("parses a table that does not start at line zero", () => {
    const lines = ["Some prose.", "", "| A | B |", "|---|---|", "| 1 | 2 |"];
    expect(parseTable(lines, 2).rows).toEqual([["1", "2"]]);
  });
});

describe("splitRow", () => {
  it("discards the outer pipes", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
  });

  it("copes with a row missing its outer pipes", () => {
    expect(splitRow("a | b")).toEqual(["a", "b"]);
  });

  it("treats an escaped pipe as content", () => {
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("keeps empty cells rather than collapsing them", () => {
    expect(splitRow("| a |  | c |")).toEqual(["a", "", "c"]);
  });
});

describe("isDelimiter", () => {
  it("recognises the shapes models actually emit", () => {
    expect(isDelimiter("|---|---|")).toBe(true);
    expect(isDelimiter("|----------|----|----|")).toBe(true);
    expect(isDelimiter("| :--- | ---: | :---: |")).toBe(true);
    expect(isDelimiter("|-|-|")).toBe(true);
  });

  it("rejects anything that is not one", () => {
    expect(isDelimiter("| a | b |")).toBe(false);
    expect(isDelimiter("")).toBe(false);
    expect(isDelimiter(undefined)).toBe(false);
    expect(isDelimiter("| 1-2 | 3 |")).toBe(false);
  });
});

describe("alignments", () => {
  it("reads alignment from the colons", () => {
    expect(alignments("| :--- | ---: | :---: | --- |"))
      .toEqual(["left", "right", "center", "left"]);
  });
});

describe("isNumeric", () => {
  it("recognises the number formats these answers contain", () => {
    expect(isNumeric("5.58e-04")).toBe(true);
    expect(isNumeric("1,790")).toBe(true);
    expect(isNumeric("-3")).toBe(true);
    expect(isNumeric("0.5")).toBe(true);
    expect(isNumeric("12%")).toBe(true);
  });

  it("does not mistake prose for a number", () => {
    expect(isNumeric("Highest carrier frequency")).toBe(false);
    expect(isNumeric("")).toBe(false);
    expect(isNumeric("1 in 1,790")).toBe(false);
  });
});
