/**
 * The FAQ, at /faq.
 *
 * Exists so `/about` can stay a statement rather than drifting into a support
 * document. The questions here are the expectation-setting ones — will this
 * test my DNA, will it tell me if I am sick, what happens to my file — and each
 * one has a short answer that would have made `/about` a worse page.
 *
 * Same editorial rules as `about.jsx`: third person, no hype, no dramatising,
 * and nothing claimed that the product does not do. One addition specific to
 * this page: **an answer that is "no" says no in the first word.** A reader
 * scanning for whether MyDNA diagnoses them should not have to parse a
 * paragraph to find out.
 *
 * Collapsed by default, for the same reason Explore Further is grouped rather
 * than flat — seventeen open answers is a wall in which the one being looked
 * for is lost. Native <details>, so it works with no JavaScript and keyboard
 * and screen-reader behaviour comes for free.
 *
 * **Numbers in here are a fifth place pricing is published.** Free allowance,
 * credit pack size, and scan cost all restate backend constants
 * (`FREE_QUERY_LIMIT`, `CREDITS_PER_PACK`, `SCAN_CREDITS` in
 * `services/billing.py`) and live Stripe prices. Changing any of them means
 * changing the copy here too — there is no import that would catch it.
 */

function Group({ title, children }) {
  return (
    <section style={{ marginTop: "2.25rem" }}>
      <h2 style={{
        fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.09em",
        textTransform: "uppercase", color: "var(--accent)", margin: "0 0 0.35rem",
      }}>{title}</h2>
      {children}
    </section>
  );
}

function Q({ q, children }) {
  return (
    <details className="faq-item">
      <summary>
        <span>{q}</span>
        <svg className="faq-chevron" viewBox="0 0 20 20" width="13" height="13"
          fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="faq-answer">{children}</div>
    </details>
  );
}

export default function FaqPage({ onBack }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", overflowY: "auto" }}>
      {/* Scoped rather than in index.css: these rules describe this page only,
          and `details[open]` cannot be expressed as an inline style. */}
      <style>{`
        .faq-item {
          border-bottom: 1px solid rgb(var(--c-border) / 0.3);
        }
        .faq-item > summary {
          display: flex; align-items: center; justify-content: space-between;
          gap: 1rem; cursor: pointer; list-style: none;
          padding: 0.85rem 0; font-size: 0.9rem; line-height: 1.5;
          font-weight: 600; color: var(--text);
        }
        .faq-item > summary::-webkit-details-marker { display: none; }
        .faq-item > summary:hover { color: var(--accent); }
        .faq-item > summary:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px;
        }
        .faq-chevron {
          flex-shrink: 0; color: var(--text-dim);
          transition: transform 0.18s ease;
        }
        .faq-item[open] > summary > .faq-chevron { transform: rotate(180deg); }
        .faq-answer {
          padding: 0 0 1.05rem;
          font-size: 0.875rem; line-height: 1.7; color: var(--text-muted);
        }
        .faq-answer p { margin: 0 0 0.7rem; }
        .faq-answer p:last-child { margin-bottom: 0; }
        .faq-answer strong { color: var(--text-secondary); }
        @media (prefers-reduced-motion: reduce) {
          .faq-chevron { transition: none; }
        }
      `}</style>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "2.5rem 1.5rem 4rem" }}>

        <button onClick={onBack}
          style={{
            background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: "0.78rem", color: "var(--accent)", marginBottom: "2rem",
          }}>← Back to MyDNA</button>

        <img src="/logo-stacked.png" alt="MyDNA" width="140"
          style={{ display: "block", height: "auto", marginBottom: "1.5rem" }} />

        <h1 style={{
          fontSize: "1.6rem", fontWeight: 700, color: "var(--text)",
          lineHeight: 1.3, margin: "0 0 0.75rem", textWrap: "balance",
        }}>
          Questions people ask before they trust it
        </h1>

        <p style={{ fontSize: "0.95rem", lineHeight: 1.7, color: "var(--text-muted)", margin: 0 }}>
          The short answers. <a href="/about" style={{ color: "var(--accent)" }}>About MyDNA</a>{" "}
          covers why it exists and where the research comes from.
        </p>

        <Group title="Before you start">
          <Q q="Will MyDNA test my DNA?">
            <p>
              <strong>No.</strong> It never sequences anything. You bring a file you
              already have from a consumer testing service, and MyDNA reads it in
              your browser to work out which findings are relevant to you.
            </p>
          </Q>
          <Q q="Do I need a DNA file to use it?">
            <p>
              <strong>No</strong> — most of MyDNA works without one. You can ask
              about any gene, variant or condition and get the same research from
              the same 28 databases.
            </p>
            <p>
              A file adds one thing, and it is the thing nothing else can do: it
              shows which of the variants under discussion appear in your own data.
            </p>
          </Q>
          <Q q="Which files does it accept?">
            <p>
              Raw data exports from <strong>23andMe</strong> and{" "}
              <strong>AncestryDNA</strong>, and <strong>VCF</strong> files. These
              are the "raw data" downloads those services offer, not the PDF
              reports they show you on screen.
            </p>
          </Q>
        </Group>

        <Group title="What it will and will not tell you">
          <Q q="Will it tell me whether I have a condition?">
            <p>
              <strong>No, and that is enforced rather than promised.</strong> Two
              independent guards sit on every answer — one reads the question
              before anything is written, the other is part of every prompt, so
              neither depends on the other having worked.
            </p>
            <p>
              A question like "do I have this?" is not refused outright. It is
              answered with what the data actually shows — which gene is
              associated with which condition, in whose cohort, at what strength —
              and then plainly told that this is not a diagnosis. The underlying
              relationship is a real fact you are entitled to; refusing it
              outright would be unhelpful and faintly dishonest.
            </p>
          </Q>
          <Q q="Can it be wrong?">
            <p>
              <strong>Yes.</strong> The research it quotes is real and the links
              go to the original records, but the model that writes the
              explanation can still make mistakes.
            </p>
            <p>
              That is exactly why every claim is traceable. Findings link back to
              the record they came from, so anything here can be checked against
              the source rather than taken on trust.
            </p>
          </Q>
          <Q q="Is MyDNA a medical service?">
            <p>
              <strong>No.</strong> It does not diagnose, does not advise on
              treatment, and is not a substitute for a clinician or a genetic
              counsellor. Where a clinical genetic test exists for a gene, MyDNA
              will tell you it exists — that is information, not a recommendation.
            </p>
          </Q>
          <Q q="Is MyDNA a research database?">
            <p>
              <strong>No.</strong> It holds no genetic research of its own. Every
              answer is assembled from live queries to public databases maintained
              by other institutions — NCBI, EMBL-EBI, UniProt, the Monarch
              Initiative and others.
            </p>
            <p>
              The science belongs to them. MyDNA is the part that brings it
              together and explains it.
            </p>
          </Q>
        </Group>

        <Group title="Your data">
          <Q q="What happens to my DNA file?">
            <p>
              It is read <strong>in your browser and never uploaded</strong>.
              Parsed variants stay in your browser's session storage and are gone
              when you close the tab.
            </p>
            <p>
              When a question needs them, only the variants relevant to that
              question are sent — the ones named in the question, or sitting
              inside the gene being discussed. They are used to write the answer
              and are never written to a database.
            </p>
          </Q>
          <Q q="What about documents I upload?">
            <p>
              Two paths, and which one applies depends on the file. A{" "}
              <strong>PDF with a text layer</strong> is read entirely in your
              browser and nothing leaves your device. A <strong>photo or a
              scan</strong> has no text to read, so it is sent to Anthropic to be
              transcribed, and that costs a credit per page.
            </p>
            <p>
              Neither is ever stored — not the file, not the text pulled out of
              it.
            </p>
          </Q>
          <Q q="Why do I have to sign in to upload?">
            <p>
              Genetic data is special category data, processed on explicit
              consent, and consent has to be recorded against someone.{" "}
              <strong>It is not a paywall</strong> — uploads stay inside the free
              allowance.
            </p>
            <p>
              What gets recorded is a bare timestamp. No file, no variants, no
              record of what was then looked at.
            </p>
          </Q>
          <Q q="Can I delete everything?">
            <p>
              <strong>Yes</strong>, from Settings → Your Data, without asking
              anyone. The same panel exports your account as a portable JSON file
              first if you want a copy.
            </p>
            <p>
              Deleting removes the account, its queries and its projects. If you
              have a subscription, cancel it in Stripe as well — deleting our
              record of it does not stop the billing.
            </p>
          </Q>
          <Q q="Do you sell my data?">
            <p>
              <strong>No.</strong> There is no advertising and no analytics
              profile, and nothing is passed to anyone except the public
              databases needed to answer the question you asked. Signed-out
              visitors are not recorded at all.
            </p>
          </Q>
        </Group>

        <Group title="What it costs">
          <Q q="What does it cost?">
            <p>
              There is a <strong>free allowance of 20 questions</strong> once you
              are signed in. After that, three options: <strong>$5</strong> for
              200 questions, <strong>$10 a month</strong> for unlimited, or{" "}
              <strong>$25 once</strong> to use your own Anthropic API key — after
              which you pay Anthropic directly and MyDNA costs you nothing
              further.
            </p>
            <p>
              The prices shown in the app are the live ones, and they are what
              you will be charged.
            </p>
          </Q>
          <Q q="Why do some things cost a credit and others don't?">
            <p>
              Price follows measured cost. A question runs a model, so it costs a
              credit. <strong>Opening one of the extra sections on an answer is
              free</strong> — it calls no model at all, just a database, so
              charging for it would have bought you nothing.
            </p>
            <p>
              A scanned page costs four credits, because reading an image runs a
              considerably larger model than a question does.
            </p>
          </Q>
        </Group>

        <Group title="When something looks wrong">
          <Q q="Why did an answer say a source was unavailable?">
            <p>
              Because it was, and saying so is deliberate. Public databases move
              and retire their endpoints without notice — an audit of MyDNA's own
              sources found ten of twenty quietly returning nothing while
              reporting success.
            </p>
            <p>
              Naming the ones that could not be reached keeps{" "}
              <strong>"there is no data"</strong> distinguishable from{" "}
              <strong>"we could not ask"</strong>. On the page those look
              identical, and they mean very different things.
            </p>
          </Q>
          <Q q="Why did it find nothing for my question?">
            <p>
              Sometimes there genuinely is nothing, and that is a real answer
              rather than a failure — a tumour suppressor with no drug candidates
              has none because of what it does, not because the lookup broke.
            </p>
            <p>
              MyDNA says so plainly rather than filling the space. If a whole
              answer comes back empty, it will tell you that too.
            </p>
          </Q>
        </Group>

        <Group title="Getting in touch">
          <Q q="How do I contact you?">
            <p>
              <a href="mailto:support@mydna.chat" style={{ color: "var(--accent)" }}>
                support@mydna.chat
              </a>{" "}
              for anything about MyDNA — bugs, questions, feature requests.
            </p>
            <p>
              <a href="mailto:privacy@mydna.chat" style={{ color: "var(--accent)" }}>
                privacy@mydna.chat
              </a>{" "}
              for data protection only: access, export or erasure. The two are
              kept apart on purpose, so a rights request cannot go unanswered in
              a support queue.
            </p>
          </Q>
        </Group>

        <div style={{
          marginTop: "2.5rem", paddingTop: "1.25rem",
          borderTop: "1px solid rgb(var(--c-border) / 0.3)",
        }}>
          <p style={{ fontSize: "0.72rem", color: "var(--text-dim)", lineHeight: 1.6, margin: 0 }}>
            For research and educational purposes only. Not a substitute for
            professional medical advice, diagnosis, or genetic counselling. See
            the <a href="/terms" style={{ color: "var(--text-dim)" }}>Terms</a> and{" "}
            <a href="/privacy" style={{ color: "var(--text-dim)" }}>Privacy Policy</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
