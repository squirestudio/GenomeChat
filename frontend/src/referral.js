/**
 * Share targets for a referral link, as plain URLs.
 *
 * **Every one of these is an ordinary link the reader clicks.** No SDK, no
 * embedded button, no `<script>` from another origin. The official share widgets
 * all load third-party JavaScript that runs on the page it sits on, and a
 * tracking script on a page about someone's genome is not a trade worth making —
 * so these are hand-rolled "intent" URLs, which is the documented way to open a
 * platform's own compose window with text already in it.
 *
 * Consequences worth knowing:
 *   - Nothing is measured. There is no click count and no attribution beyond the
 *     referral code itself, which is the point rather than a limitation.
 *   - The destination sees the code, because it is in the link being shared.
 *     That is inherent, and harmless: the code is random and says nothing about
 *     its owner.
 *   - Links open with `rel="noreferrer"` so the destination does not learn which
 *     page the reader came from.
 *
 * **The message never says anything about the sharer.** A line like "this helped
 * me understand my diagnosis" would disclose a health condition to everyone who
 * reads it, which is a strange thing for a privacy-first product to compose on
 * someone's behalf. It describes the tool and stops there. Every one of these
 * opens an editable draft, so nobody is stuck with the wording.
 */

/** Neutral about the sharer, and short enough for the strictest destination. */
const PITCH = "I've been using MyDNA — you can ask questions about genes and conditions in plain English, and it shows where every answer came from.";

const SUBJECT = "Thought you'd find this useful";

/**
 * `{ id, label, href }` for each destination.
 *
 * SMS is deliberately absent. The no-recipient form is `sms:&body=` on iOS and
 * `sms:?body=` on Android, the tolerant `sms:?&body=` is not reliable across
 * both, and shipping a button that silently opens an empty message on one of the
 * two big platforms is worse than not offering it.
 */
function shareTargets(url) {
  const link = String(url || "");
  const enc = encodeURIComponent;
  return [
    {
      id: "email",
      label: "Email",
      href: `mailto:?subject=${enc(SUBJECT)}&body=${enc(`${PITCH}\n\n${link}`)}`,
    },
    {
      id: "whatsapp",
      label: "WhatsApp",
      href: `https://wa.me/?text=${enc(`${PITCH} ${link}`)}`,
    },
    {
      id: "x",
      label: "X",
      // `text` and `url` are separate parameters on purpose: X appends and
      // shortens the URL itself, and folding it into the text costs characters
      // twice over.
      href: `https://x.com/intent/post?text=${enc(PITCH)}&url=${enc(link)}`,
    },
  ];
}

export { shareTargets, PITCH, SUBJECT };
