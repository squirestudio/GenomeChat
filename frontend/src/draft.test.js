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

  it("the mailing address is still the only thing outstanding", () => {
    // When this fails because the list is empty, the draft banner has served
    // its purpose and can come off the page.
    expect(unresolved(privacyMd)).toEqual(["MAILING ADDRESS"]);
  });
});
