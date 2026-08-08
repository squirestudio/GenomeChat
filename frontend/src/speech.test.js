import { describe, it, expect } from "vitest";
import { speakableText, chunkForSpeech, pickVoice, speechAvailable, spellToken,
         describeVoiceSupport, installHint, platformKey } from "./speech";

describe("pickVoice", () => {
  // The privacy-critical part. Chrome ships network-backed Google voices next
  // to the operating system's, and choosing one sends the utterance text — the
  // reader's gene, often their own genotype — to Google to be synthesised.
  const local = { name: "Samantha", lang: "en-US", localService: true, default: true };
  const remote = { name: "Google US English", lang: "en-US", localService: false };

  it("never returns a remote voice, even when it is the only one", () => {
    expect(pickVoice([remote])).toBeNull();
    expect(speechAvailable([remote])).toBe(false);
  });

  it("prefers a local voice when both are offered", () => {
    expect(pickVoice([remote, local])).toBe(local);
  });

  it("matches the language before falling back", () => {
    const de = { name: "Anna", lang: "de-DE", localService: true };
    const en = { name: "Daniel", lang: "en-GB", localService: true };
    expect(pickVoice([de, en], "en-US")).toBe(en);
    expect(pickVoice([de], "en-US")).toBe(de);  // better than silence
  });

  it("is safe on an empty or missing list", () => {
    expect(pickVoice([])).toBeNull();
    expect(pickVoice(undefined)).toBeNull();
    expect(speechAvailable([])).toBe(false);
  });
});

describe("speakableText", () => {
  it("does not read markdown punctuation aloud", () => {
    const out = speakableText("## Overview\n\nThe **BRCA1** gene is *large*.");
    expect(out).not.toMatch(/[#*_`]/);
    expect(out).toContain("Overview");
  });

  it("keeps link text and drops the URL", () => {
    expect(speakableText("See [ClinVar](https://example.com/x) for more."))
      .toBe("See ClinVar for more.");
  });

  it("spells gene symbols instead of pronouncing them as words", () => {
    // A synthesiser reads BRCA1 as "brocka one", which is both wrong and hard
    // to map back onto what is on screen.
    expect(speakableText("BRCA1 variants")).toBe("B R C A 1 variants");
    expect(spellToken("TP53")).toBe("T P 53");
  });

  it("says rsIDs the way they are said aloud", () => {
    expect(speakableText("The rs334 variant")).toBe("The r s 334 variant");
    expect(speakableText("rs1801133 and RS429358")).toContain("r s 1801133");
  });

  it("reads scientific notation as a number rather than as letters", () => {
    // "5.58e-04" spoken literally is "five point five eight e zero four".
    expect(speakableText("Frequency 5.58e-04 in gnomAD"))
      .toContain("5.58 times ten to the minus 4");
    expect(speakableText("about 2.1E+03")).toContain("2.1 times ten to the 3");
  });

  it("announces a table rather than reciting it", () => {
    // A frequency table read aloud is a stream of numbers with no structure —
    // a listener cannot hear the difference between a column break and a
    // decimal point.
    const md = [
      "Population data:",
      "",
      "| Group | Frequency |",
      "|---|---|",
      "| African | 0.12 |",
      "| European | 0.03 |",
      "",
      "That is the spread.",
    ].join("\n");
    const out = speakableText(md);
    expect(out).toContain("A table of figures follows on screen.");
    expect(out).not.toContain("0.12");
    expect(out).toContain("That is the spread.");
  });

  it("announces a table once, however many there are", () => {
    const t = "| a | b |\n|---|---|\n| 1 | 2 |";
    const out = speakableText(`${t}\n\ntext\n\n${t}`);
    expect(out.match(/A table of figures/g)).toHaveLength(1);
  });

  it("drops list and rule markers but keeps the content", () => {
    const out = speakableText("- first item\n- second item\n\n---\n\n1. third");
    expect(out).toContain("first item");
    expect(out).toContain("third");
    expect(out).not.toMatch(/^-|^\d\./m);
  });

  it("is safe on nothing", () => {
    expect(speakableText("")).toBe("");
    expect(speakableText(null)).toBe("");
    expect(speakableText("   ")).toBe("");
  });
});

describe("chunkForSpeech", () => {
  // Chrome has cut long utterances off mid-sentence for years and the exact
  // threshold moves between releases, so nothing should rely on it.

  it("splits on sentence boundaries", () => {
    const chunks = chunkForSpeech("One sentence here. Two sentence here. Three.", 25);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(25));
  });

  it("keeps short text as a single utterance", () => {
    expect(chunkForSpeech("Short answer.", 180)).toEqual(["Short answer."]);
  });

  it("breaks a sentence longer than the budget rather than dropping it", () => {
    const long = "a".repeat(500);
    const chunks = chunkForSpeech(long, 100);
    expect(chunks.join("")).toContain("a".repeat(100));
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(100));
  });

  it("loses no words", () => {
    const text = "The BRCA1 gene is large. It has many exons. Variants matter.";
    const words = chunkForSpeech(text, 30).join(" ").split(/\s+/).filter(Boolean);
    expect(words).toEqual(text.split(/\s+/).filter(Boolean));
  });

  it("is safe on nothing", () => {
    expect(chunkForSpeech("")).toEqual([]);
    expect(chunkForSpeech(null)).toEqual([]);
  });
});

describe("describeVoiceSupport", () => {
  // "No button appeared" has three causes needing three different answers.
  const local = { name: "Samantha", lang: "en-US", localService: true, default: true };
  const remote = { name: "Google US English", lang: "en-US", localService: false };

  it("distinguishes no API from no voices", () => {
    expect(describeVoiceSupport([], false).status).toBe("unsupported");
    expect(describeVoiceSupport([], true).status).toBe("none");
  });

  it("calls out the surprising case: voices exist but all are remote", () => {
    // The reader plainly has voices, so telling them there are none reads as
    // a bug. They need to know we are refusing these ones, and why.
    const r = describeVoiceSupport([remote, remote]);
    expect(r.status).toBe("remote_only");
    expect(r.remote).toBe(2);
    expect(r.voice).toBeNull();
  });

  it("reports the chosen voice when one is usable", () => {
    const r = describeVoiceSupport([remote, local]);
    expect(r.status).toBe("ready");
    expect(r.local).toBe(1);
    expect(r.voice).toBe(local);
  });
});

describe("installHint", () => {
  it("names the actual setting for each platform", () => {
    expect(installHint("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toMatch(/Spoken Content/);
    expect(installHint("Mozilla/5.0 (Windows NT 10.0; Win64)")).toMatch(/Manage voices/);
    expect(installHint("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toMatch(/Spoken Content/);
    expect(installHint("Mozilla/5.0 (Linux; Android 14)")).toMatch(/Text-to-speech/);
    expect(installHint("Mozilla/5.0 (X11; Linux x86_64)")).toMatch(/espeak/);
  });

  it("falls back rather than returning nothing", () => {
    expect(installHint("", "")).toBeTruthy();
    expect(installHint(undefined, undefined)).toBeTruthy();
  });

  it("checks iOS before mac, since an iPhone UA contains neither cleanly", () => {
    // "iPhone" and "Mac OS X" both appear in an iOS user-agent string.
    expect(platformKey("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
  });
});
