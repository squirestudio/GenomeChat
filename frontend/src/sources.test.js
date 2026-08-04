import { describe, it, expect } from "vitest";
import { SOURCES, SOURCE_COUNT, FOOTER_NAMED, FOOTER_REMAINDER } from "./sources";
import aboutSrc from "./about.jsx?raw";
import faqSrc from "./faq.jsx?raw";
import appSrc from "./App.jsx?raw";

describe("the source list", () => {
  it("has no duplicates, which would inflate the count silently", () => {
    expect(new Set(SOURCES).size).toBe(SOURCES.length);
  });

  it("names every footer source in the full list", () => {
    // A typo here would not throw — it would just quietly make FOOTER_REMAINDER
    // one too many, and "and 24 more" beside five names is not obviously wrong.
    for (const name of FOOTER_NAMED) expect(SOURCES).toContain(name);
  });

  it("adds up: named + remainder is the whole list", () => {
    expect(FOOTER_NAMED.length + FOOTER_REMAINDER).toBe(SOURCE_COUNT);
  });

  it("excludes OMIM, which is fetched but withheld for licensing", () => {
    // Listing it would advertise a section no reader can open.
    expect(SOURCES).not.toContain("OMIM");
  });
});

describe("no page hand-writes a source count", () => {
  // This is the actual regression guard. The welcome tour said "23 public
  // research databases" while /about listed 28 and the FAQ said 28 — and the
  // footer's "and 23 more" was *correct*, because 28 minus five named is 23.
  // Two identical numbers on one site, one right and one wrong, which is not
  // something anyone was going to catch by reading.
  //
  // Counts are interpolated now, so a literal one in this prose means somebody
  // typed a number that will drift the next time a source is added.
  const COUNT_IN_PROSE = /\b\d{1,3}\s+(?:public|research|external|biomedical|genomic|more\b|databases|sources)/gi;

  // "23andMe" is a product name, and the FAQ names the file formats it accepts.
  const ALLOWED = /23andMe/i;

  for (const [name, src] of [["about.jsx", aboutSrc], ["faq.jsx", faqSrc], ["App.jsx", appSrc]]) {
    it(`${name} interpolates it rather than typing it`, () => {
      const hits = (src.match(COUNT_IN_PROSE) || []).filter(h => !ALLOWED.test(h));
      expect(hits).toEqual([]);
    });
  }

  it("the pages that quote the count actually import it", () => {
    expect(faqSrc).toContain('from "./sources"');
    expect(appSrc).toContain('from "./sources"');
    expect(aboutSrc).toContain('from "./sources"');
  });

  it("about.jsx no longer keeps its own copy of the list", () => {
    // It held the original array; two lists is how the count drifted.
    expect(aboutSrc).not.toMatch(/const SOURCES = \[/);
  });
});
