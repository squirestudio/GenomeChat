import { describe, it, expect } from "vitest";
import { VIEWS, VIEW_FENCE, parseViewBlock, resolveView, viewCatalogue } from "./views";

describe("parseViewBlock", () => {
  const lines = ["```mydna-view", '{"view": "karyogram"}', "```", "After."];

  it("reads the spec and resumes after the fence", () => {
    const { spec, endsAt } = parseViewBlock(lines, 0);
    expect(spec).toEqual({ view: "karyogram" });
    expect(lines[endsAt]).toBe("After.");
  });

  it("yields no spec for a block still being streamed", () => {
    // Answers stream, so a half-written spec is normal rather than broken. It
    // must not eat the rest of the answer either.
    const partial = ["```mydna-view", '{"view": "karyo'];
    const { spec, endsAt } = parseViewBlock(partial, 0);
    expect(spec).toBeNull();
    expect(endsAt).toBe(partial.length);
  });

  it("refuses a spec that is not an object", () => {
    expect(parseViewBlock(["```mydna-view", '["karyogram"]', "```"], 0).spec).toBeNull();
    expect(parseViewBlock(["```mydna-view", '"karyogram"', "```"], 0).spec).toBeNull();
  });

  it("treats an empty block as an empty spec rather than throwing", () => {
    expect(parseViewBlock(["```mydna-view", "```"], 0).spec).toEqual({});
  });

  it("matches only its own fence", () => {
    expect(VIEW_FENCE.test("```mydna-view")).toBe(true);
    expect(VIEW_FENCE.test("```json")).toBe(false);
    expect(VIEW_FENCE.test("```")).toBe(false);
  });
});

describe("resolveView", () => {
  it("renders when the requirement is met", () => {
    const r = resolveView({ view: "karyogram" }, { dna: true });
    expect(r.status).toBe("render");
    expect(r.view).toBe("karyogram");
  });

  it("explains an unmet requirement to the reader, not to a developer", () => {
    // "Upload your DNA file" is actionable; "dnaData is null" is not.
    const r = resolveView({ view: "helix" }, { dna: false, locus: true });
    expect(r.status).toBe("unavailable");
    expect(r.reason).toMatch(/upload your dna/i);
    expect(r.reason).not.toMatch(/null|undefined|dnaData/);
  });

  it("needs every requirement, not just one", () => {
    expect(resolveView({ view: "helix" }, { dna: true }).status).toBe("unavailable");
    expect(resolveView({ view: "helix" }, { dna: true, locus: true }).status).toBe("render");
  });

  it("names an unknown view rather than failing silently", () => {
    // The model will have written "here is the map" above it either way, so a
    // view that vanishes leaves a dangling sentence.
    const r = resolveView({ view: "sankey_diagram" }, {});
    expect(r.status).toBe("unknown");
    expect(r.reason).toContain("sankey_diagram");
    expect(r.known).toContain("karyogram");
  });

  it("is safe on junk", () => {
    for (const junk of [null, undefined, {}, { view: "" }, { view: 42 }]) {
      expect(resolveView(junk, {}).status).toBe("unknown");
    }
  });

  it("is case and whitespace tolerant", () => {
    expect(resolveView({ view: "  Karyogram " }, { dna: true }).status).toBe("render");
  });
});

describe("viewCatalogue", () => {
  it("describes every view, so the prompt cannot drift from the code", () => {
    const cat = viewCatalogue();
    expect(cat.length).toBe(Object.keys(VIEWS).length);
    for (const v of cat) {
      expect(v.name).toBeTruthy();
      expect(v.hint, v.name).toBeTruthy();
      expect(Array.isArray(v.requires)).toBe(true);
    }
  });

  it("every view states what it needs and what to do about it", () => {
    for (const [name, d] of Object.entries(VIEWS)) {
      expect(d.requires.length, name).toBeGreaterThan(0);
      expect(d.needs, name).toBeTruthy();
    }
  });
});
