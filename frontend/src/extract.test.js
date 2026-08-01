import { describe, it, expect } from "vitest";
import { classifyFile, needsVision, costNote } from "./extract";

// Only the routing decision is tested here: it decides whether a file is read
// locally for free or sent to a vision model for a credit, so getting it wrong
// either overcharges someone or ships their page image when it did not need to
// go. The extraction itself is pdf.js and canvas, which need a browser.

const f = (name, type = "") => ({ name, type });

describe("classifyFile", () => {
  it("recognises PDFs by type and by extension", () => {
    expect(classifyFile(f("paper.pdf", "application/pdf"))).toBe("pdf");
    expect(classifyFile(f("paper.pdf"))).toBe("pdf");
  });

  it("recognises HEIC even when the browser reports no type", () => {
    // Chrome and Firefox commonly report "" for HEIC, so the extension is the
    // only reliable signal — and these are exactly the iPhone photos of journal
    // pages that this feature exists to read.
    expect(classifyFile(f("IMG_1234.HEIC", ""))).toBe("heic");
    expect(classifyFile(f("IMG_1234.heic", "image/heic"))).toBe("heic");
    expect(classifyFile(f("scan.heif", ""))).toBe("heic");
  });

  it("recognises ordinary images and text", () => {
    expect(classifyFile(f("page.jpg", "image/jpeg"))).toBe("image");
    expect(classifyFile(f("page.png", "image/png"))).toBe("image");
    expect(classifyFile(f("notes.txt", "text/plain"))).toBe("text");
    expect(classifyFile(f("notes.md", ""))).toBe("text");
  });

  it("refuses everything else rather than guessing", () => {
    expect(classifyFile(f("paper.docx", "application/vnd.openxmlformats"))).toBe("unsupported");
    expect(classifyFile(f("data.zip", "application/zip"))).toBe("unsupported");
    expect(classifyFile({})).toBe("unsupported");
    expect(classifyFile(null)).toBe("unsupported");
  });
});

describe("needsVision", () => {
  it("is true only for the paths with no text layer", () => {
    expect(needsVision("image")).toBe(true);
    expect(needsVision("heic")).toBe(true);
    expect(needsVision("pdf")).toBe(false);
    expect(needsVision("text")).toBe(false);
  });
});

describe("costNote", () => {
  it("promises locality only where locality is real", () => {
    // The PDF path genuinely never leaves the device. The image path does, and
    // the note must not claim otherwise — the upload copy is a commitment.
    expect(costNote("pdf")).toContain("nothing leaves your device");
    expect(costNote("image")).not.toContain("nothing leaves your device");
    expect(costNote("heic")).toContain("credit");
  });

  it("says nothing about an unsupported file", () => {
    expect(costNote("unsupported")).toBe("");
  });
});
