import { describe, it, expect } from "vitest";
import { shareTargets, PITCH } from "./referral";

const URL_ = "https://mydna.chat/?r=7Kq2mX";

describe("shareTargets", () => {
  it("carries the referral link to every destination", () => {
    for (const t of shareTargets(URL_)) {
      expect(decodeURIComponent(t.href), t.id).toContain(URL_);
    }
  });

  it("encodes the link rather than pasting it raw", () => {
    // The link contains `?r=`, which would terminate the intent's own query
    // string and drop the code if it were not encoded.
    for (const t of shareTargets(URL_)) {
      if (t.id === "email") continue;                 // mailto body, same rule
      expect(t.href).not.toContain("?r=7Kq2mX&");
      expect(t.href).toContain(encodeURIComponent(URL_).slice(0, 20));
    }
  });

  it("uses only mailto and https, never a script or an SDK", () => {
    // The whole reason these are hand-rolled: the official widgets load
    // third-party JavaScript, and a tracking script on a page about someone's
    // genome is not a trade worth making.
    for (const t of shareTargets(URL_)) {
      expect(t.href, t.id).toMatch(/^(mailto:|https:\/\/)/);
      expect(t.href).not.toMatch(/javascript:|<script|sdk|platform\.js/i);
    }
  });

  it("says nothing about the person sharing", () => {
    // "This helped me understand my diagnosis" would disclose a health
    // condition to everyone who reads it. The pitch describes the tool only.
    expect(PITCH).not.toMatch(/\bmy (diagnosis|condition|results|genes|dna|health)\b/i);
    expect(PITCH).not.toMatch(/\bI (have|was diagnosed|found out)\b/i);
  });

  it("keeps the X draft inside the character budget", () => {
    // X counts the URL as 23 characters however long it is.
    expect(PITCH.length + 24).toBeLessThanOrEqual(280);
  });

  it("gives every target a stable id and a label", () => {
    const targets = shareTargets(URL_);
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets.map(t => t.id)).size).toBe(targets.length);
    for (const t of targets) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
    }
  });

  it("is safe on a missing url", () => {
    expect(() => shareTargets(undefined)).not.toThrow();
    expect(() => shareTargets(null)).not.toThrow();
  });
});
