/**
 * Reading an answer aloud, on the reader's own machine.
 *
 * Opt-in accessibility, off by default. Two decisions shape the whole module,
 * and both are about what leaves the device.
 *
 * **Only local voices are used, and that is a privacy constraint rather than a
 * quality preference.** `speechSynthesis` sounds local and often is not:
 * Chrome ships network-backed Google voices alongside the operating system's,
 * and selecting one sends the utterance text to Google to be synthesised. The
 * text of an answer names the reader's gene, and frequently their own variants.
 * MyDNA promises that DNA is read in the browser and never uploaded, so quietly
 * posting the sentence "your rs334 genotype is AS" to a speech API would break
 * that promise in the one place nobody would think to look. `pickVoice` accepts
 * only `localService` voices and the feature reports itself unavailable rather
 * than falling back to a remote one.
 *
 * **Speech input was considered and rejected**, and the reasons still hold.
 * `SpeechRecognition` in Chrome streams microphone audio to Google's servers —
 * the same objection, with worse consequences. And dictation is poor at exactly
 * this vocabulary: "rs334" and "BRCA1" come back as "RS 334" and "brca one" at
 * best, and a misheard rsID is a different variant with no way for anything
 * downstream to notice. Output only.
 */

/** Markdown that should never be spoken as characters. */
const INLINE_MARKS = /(\*\*|__|\*|_|`)/g;

/**
 * A gene symbol or similar all-caps token, spelled out.
 *
 * Left alone, a synthesiser reads BRCA1 as a word — "brocka one" — which is
 * both wrong and hard to map back onto what is on screen. Spelling the letters
 * matches how these are actually said aloud. Digits stay as numbers, so TP53
 * becomes "T P 53" rather than "T P five three".
 */
function spellToken(token) {
  return token.replace(/[A-Z]/g, (c) => `${c} `).replace(/\s+/g, " ").trim();
}

/**
 * Turn an answer into something worth hearing.
 *
 * Tables are announced rather than read. A frequency table read aloud is a
 * stream of numbers with no structure — the listener cannot tell a column
 * boundary from a decimal point — so saying that one is on screen is more
 * useful than reciting it.
 */
function speakableText(markdown) {
  const src = String(markdown ?? "");
  if (!src.trim()) return "";

  const out = [];
  const lines = src.split("\n");
  let announcedTable = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // A table: header, delimiter, then rows. Announce once and skip the block.
    if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]*-[\s:|-]*$/.test(lines[i + 1] || "")) {
      while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
      if (!announcedTable) { out.push("A table of figures follows on screen."); announcedTable = true; }
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;   // horizontal rule
    if (!line.trim()) { out.push(""); continue; }

    line = line.replace(/^#{1,6}\s+/, "");                      // heading marks
    line = line.replace(/^\s*[-•*]\s+/, "");                    // bullet marks
    line = line.replace(/^\s*\d+\.\s+/, "");                    // ordered marks
    line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");        // links keep their text
    line = line.replace(INLINE_MARKS, "");

    // rsIDs are said "r s three three four", never "rs" as a word.
    line = line.replace(/\brs(\d+)\b/gi, (_m, digits) => `r s ${digits}`);

    // Scientific notation. "5.58e-04" read literally is meaningless aloud.
    line = line.replace(/(\d+(?:\.\d+)?)[eE]([+-]?)(\d+)/g,
      (_m, mant, sign, exp) => `${mant} times ten to the ${sign === "-" ? "minus " : ""}${Number(exp)}`);

    // Gene-symbol shaped tokens: 2–8 capitals, optionally with digits.
    line = line.replace(/\b[A-Z]{2,8}\d{0,4}\b/g, (tok) => spellToken(tok));

    out.push(line.trim());
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split into utterances a synthesiser will actually finish.
 *
 * Chrome has cut long utterances off mid-sentence for years — the exact
 * threshold moves between releases, so the fix is to never rely on it. Split on
 * sentence boundaries and queue, which also makes pausing land somewhere
 * sensible rather than mid-clause.
 */
function chunkForSpeech(text, maxChars = 180) {
  const clean = String(text ?? "").trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?\n]+[.!?]*\n*|\n+/g) || [clean];
  const chunks = [];
  let buf = "";

  for (const s of sentences) {
    const piece = s.replace(/\s+/g, " ").trim();
    if (!piece) continue;
    if (piece.length > maxChars) {
      if (buf) { chunks.push(buf); buf = ""; }
      // A single sentence longer than the budget still has to go somewhere;
      // split on commas before falling back to a hard cut.
      let rest = piece;
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(",", maxChars);
        const at = cut > maxChars * 0.4 ? cut + 1 : maxChars;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest) buf = rest;
      continue;
    }
    if ((buf + " " + piece).trim().length > maxChars) { chunks.push(buf); buf = piece; }
    else buf = (buf ? buf + " " : "") + piece;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * The best **local** voice for a language, or null.
 *
 * Returning null is a real answer and the caller must treat it as "speech is
 * unavailable", never as "use the default voice" — the default may well be the
 * remote one this exists to avoid.
 */
function pickVoice(voices, lang = "en") {
  const local = (voices || []).filter(v => v && v.localService);
  if (!local.length) return null;

  const base = String(lang).slice(0, 2).toLowerCase();
  const sameLang = local.filter(v => String(v.lang || "").slice(0, 2).toLowerCase() === base);
  const pool = sameLang.length ? sameLang : local;

  // A voice the platform marks default is the one the reader already hears
  // elsewhere, so it is the least surprising choice.
  return pool.find(v => v.default) || pool[0];
}

/** Whether speech can run at all, given a voice list. */
function speechAvailable(voices) {
  return pickVoice(voices) !== null;
}

export { speakableText, chunkForSpeech, pickVoice, speechAvailable, spellToken };

/**
 * What is actually available, in enough detail to tell a reader what to do.
 *
 * "No button appeared" has three different causes and they need three different
 * answers: the browser has no speech API at all, it has no voices installed, or
 * it has voices but every one of them is a network voice we refuse to use. The
 * last is the surprising one — the reader plainly *has* voices, so being told
 * there are none would read as a bug.
 */
function describeVoiceSupport(voices, hasApi = true) {
  if (!hasApi) return { status: "unsupported", local: 0, remote: 0, voice: null };

  const list = voices || [];
  const local = list.filter(v => v && v.localService);
  const remote = list.filter(v => v && !v.localService);

  if (!list.length) return { status: "none", local: 0, remote: 0, voice: null };
  if (!local.length) return { status: "remote_only", local: 0, remote: remote.length, voice: null };

  return {
    status: "ready",
    local: local.length,
    remote: remote.length,
    voice: pickVoice(list, typeof navigator !== "undefined" ? navigator.language : "en"),
  };
}

/**
 * Where this platform keeps its voices.
 *
 * Deliberately names the setting rather than describing it vaguely — someone
 * who has just been told a feature cannot work wants the next click, not a
 * suggestion to look around. Kept as data so it can be tested without a DOM.
 */
const INSTALL_HINTS = {
  mac: "System Settings → Accessibility → Spoken Content → System Voice → Manage Voices, then download any voice.",
  windows: "Settings → Time & Language → Speech → Manage voices → Add voices.",
  ios: "Settings → Accessibility → Spoken Content → Voices, then download a voice.",
  android: "Settings → Accessibility → Text-to-speech output, then install or enable an engine.",
  linux: "Install a speech-dispatcher backend such as espeak-ng, then restart the browser.",
  unknown: "Look for text-to-speech or spoken content in your operating system's accessibility settings.",
};

function platformKey(ua = "", platform = "") {
  const s = `${ua} ${platform}`.toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return "ios";
  if (/android/.test(s)) return "android";
  if (/mac/.test(s)) return "mac";
  if (/win/.test(s)) return "windows";
  if (/linux|x11|cros/.test(s)) return "linux";
  return "unknown";
}

function installHint(ua, platform) {
  return INSTALL_HINTS[platformKey(ua, platform)];
}

export { describeVoiceSupport, installHint, platformKey, INSTALL_HINTS };

