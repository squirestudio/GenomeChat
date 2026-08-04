import { describe, it, expect } from "vitest";
import { unresolved } from "./draft";
import privacyMd from "../../legal/privacy-policy.md?raw";
import termsMd from "../../legal/terms-of-use.md?raw";

describe("unresolved", () => {
  it("finds an open placeholder", () => {
    expect(unresolved("Operated from [MAILING ADDRESS], Tennessee.")).toEqual(["MAILING ADDRESS"]);
  });

  it("reports each blank once, however often it appears", () => {
    expect(unresolved("[MAILING ADDRESS] ... again at [MAILING ADDRESS]")).toEqual(["MAILING ADDRESS"]);
  });

  it("ignores ordinary bracketed prose and markdown links", () => {
    expect(unresolved("see the [Privacy Policy](./privacy-policy.md) and [note 1]")).toEqual([]);
  });

  it("is safe on nothing", () => {
    expect(unresolved("")).toEqual([]);
    expect(unresolved(null)).toEqual([]);
  });
});

describe("the published documents", () => {
  // These render live at /privacy and /terms straight from legal/*.md, so the
  // test reads the same files the page does. It is a smoke test on the wiring
  // as much as on the content: a broken ?raw import fails here rather than in
  // production.

  it("the privacy policy is the real document", () => {
    expect(privacyMd).toContain("# Privacy Policy");
    expect(privacyMd.length).toBeGreaterThan(5000);
  });

  it("the terms are the real document", () => {
    expect(termsMd).toContain("Not medical advice");
    expect(termsMd.length).toBeGreaterThan(4000);
  });

  it("both cover uploaded documents, which the code now supports", () => {
    // Added when document upload shipped. The policy is written from an audit
    // of what the code actually does, so a feature that processes a new
    // category of personal data has to appear in it.
    expect(privacyMd).toContain("## 4. Documents you upload");
    expect(termsMd).toContain("**Documents you upload**");
  });

  it("the privacy policy still numbers its sections consecutively", () => {
    // A section was inserted and the rest renumbered; an off-by-one here is
    // invisible on the page and embarrassing in a legal document.
    const numbers = [...privacyMd.matchAll(/^## (\d+)\. /gm)].map(m => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("has no blanks left, so the draft banner no longer renders", () => {
    // This assertion used to read `toEqual(["MAILING ADDRESS"])`, with a note
    // that its failure would mean the banner had done its job. The address was
    // published 4 Aug 2026 and it did. Kept inverted rather than deleted: a new
    // placeholder appearing in a published legal document should fail loudly.
    expect(unresolved(privacyMd)).toEqual([]);
    expect(unresolved(termsMd)).toEqual([]);
  });
});

describe("the postal address renders as an address", () => {
  // The address is quoted in both documents, and the markdown renderer had no
  // blockquote case until it landed — a quoted line printed a literal ">".
  // These assert the lines exist and stay separate; joining them into standard
  // markdown's lazy-continuation paragraph would produce one run-on line.

  it("both documents carry every line of it", () => {
    for (const doc of [privacyMd, termsMd]) {
      expect(doc).toContain("> Squire Studio");
      expect(doc).toContain("> 5013 S Louise Ave, Unit #803");
      expect(doc).toContain("> Sioux Falls, SD 57108");
    }
  });

  it("no residence or placeholder is left anywhere in them", () => {
    for (const doc of [privacyMd, termsMd]) {
      expect(doc).not.toMatch(/\[[A-Z][A-Z ]+\]/);
    }
  });
});

describe("the legal documents actually reach production", () => {
  // These live in ../legal and are pulled in with Vite's ?raw, so they are
  // frontend build inputs that sit outside the frontend directory. Vercel's
  // root directory is `frontend`, and it cancels a build when nothing inside
  // it changed — so a commit touching only legal/*.md deployed nothing, and
  // the corrected policy sat on main looking shipped while production served
  // the old text. Found by diffing the live bundle, which is a poor way to
  // find it.
  //
  // `ignoreCommand` exits 0 to cancel and non-zero to build, so `git diff
  // --quiet` over both paths is exactly the right test. A git failure exits
  // 128, which builds — the safe direction.
  it("vercel is told legal/ is a build input", async () => {
    const cfg = JSON.parse((await import("../vercel.json?raw")).default);
    expect(cfg.ignoreCommand).toBeTruthy();
    expect(cfg.ignoreCommand).toContain("../legal");
  });
});
