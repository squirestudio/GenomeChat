import { describe, it, expect } from "vitest";
import privacyMd from "../../legal/privacy-policy.md?raw";
import termsMd from "../../legal/terms-of-use.md?raw";
import vercelJson from "../vercel.json?raw";

/**
 * Was `draft.test.js`, alongside a `draft.js` that drove an on-page banner
 * naming any unfilled blank. Both are gone: the documents are reviewed and
 * approved, so a component whose job is to announce that they are unfinished
 * had nothing true left to say.
 *
 * The guard did not go with it — it moved here, which is the better place for
 * it. A blank in a published legal document should fail the build rather than
 * be explained to the reader who found it.
 */

/** Unfilled `[PLACEHOLDER]` markers, ignoring markdown links and ordinary prose. */
function placeholders(text) {
  const found = String(text ?? "").match(/\[[A-Z][A-Z ]{2,}\](?!\()/g) || [];
  return [...new Set(found.map(m => m.slice(1, -1)))];
}

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

  it("has no blanks left in either document", () => {
    // The last one was the mailing address, filled 4 Aug 2026. This used to be
    // asserted the other way — that the address was the only thing outstanding
    // — with a note that its failure would mean the banner had done its job.
    expect(placeholders(privacyMd)).toEqual([]);
    expect(placeholders(termsMd)).toEqual([]);
  });

  it("reads as finished — no draft or pending-review language", () => {
    // "Draft pending legal review. See `legal/README.md` for what remains
    // open." was published on both. It also pointed readers at the internal
    // decision log, which is not published and names things that appear
    // nowhere on the site by design.
    for (const doc of [privacyMd, termsMd]) {
      expect(doc).not.toMatch(/draft|pending (legal )?review|not yet final|legal\/README/i);
    }
  });

  it("carries a revised date, which the terms promise", () => {
    // Terms §17: "Material changes will be noted on the site with a revised
    // date." A stale date breaks a commitment the document makes about itself,
    // and it went stale once already — both said 30 July while carrying the
    // postal address and governing-law changes made on 4 August.
    for (const doc of [privacyMd, termsMd]) {
      expect(doc).toMatch(/\*\*Last updated:\*\* \d{1,2} \w+ \d{4}/);
      expect(doc).toMatch(/\*\*Effective:\*\* \d{1,2} \w+ \d{4}/);
    }
  });
});

describe("placeholders", () => {
  it("finds an unfilled blank", () => {
    expect(placeholders("Operated from [MAILING ADDRESS], Tennessee.")).toEqual(["MAILING ADDRESS"]);
  });

  it("reports each blank once, however often it appears", () => {
    expect(placeholders("[MAILING ADDRESS] ... again at [MAILING ADDRESS]")).toEqual(["MAILING ADDRESS"]);
  });

  it("ignores ordinary bracketed prose and markdown links", () => {
    expect(placeholders("see the [Privacy Policy](./privacy-policy.md) and [note 1]")).toEqual([]);
  });

  it("is safe on nothing", () => {
    expect(placeholders("")).toEqual([]);
    expect(placeholders(null)).toEqual([]);
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
  it("vercel is told legal/ is a build input", () => {
    const cfg = JSON.parse(vercelJson);
    expect(cfg.ignoreCommand).toBeTruthy();
    expect(cfg.ignoreCommand).toContain("../legal");
  });
});
