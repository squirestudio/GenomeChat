/**
 * The About page, at /about.
 *
 * Lives in its own module rather than in App.jsx because it is the one part of
 * the app that is prose first — the copy is the deliverable, and it should be
 * editable without scrolling past forty components to reach it.
 *
 * Editorial rules this page is written to, agreed with the founder:
 *   - Third person, with one deliberate exception. MyDNA is the subject, not
 *     the person who built it — except in "Why it exists", which is the
 *     founder's own account and reads as evasive in the third person. Rewritten
 *     to first person 3 Aug 2026. Everything else stays third person; the seam
 *     is intentional.
 *   - No panic, no worry, no hype. This is a calm page about a frightening
 *     subject, and dramatising it would be a betrayal of the reader.
 *   - Nothing claimed that the product does not do. The trust argument is
 *     traceability, so overstating anything here undermines the whole thesis.
 *   - The founder's mother is described specifically but not named.
 */

const SOURCES = [
  "ClinVar", "Ensembl", "gnomAD", "UniProt", "AlphaFold", "dbSNP", "dbVar",
  "ClinGen", "MedGen", "GTR", "HPO", "Monarch", "Reactome", "GTEx",
  "STRING", "Open Targets", "GWAS Catalog", "ClinPGx", "NCI GDC", "PubMed", "PMC",
  "MedlinePlus", "PanelApp", "ClinicalTrials.gov", "HGNC",
  "GenCC", "Orphanet", "Ensembl VEP",
];

function Section({ title, children }) {
  return (
    <section style={{ marginTop: "2.25rem" }}>
      <h2 style={{
        fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.09em",
        textTransform: "uppercase", color: "var(--accent)", margin: "0 0 0.6rem",
      }}>{title}</h2>
      {children}
    </section>
  );
}

function P({ children }) {
  return (
    <p style={{
      fontSize: "0.95rem", lineHeight: 1.7, color: "var(--text-muted)",
      margin: "0 0 0.9rem",
    }}>{children}</p>
  );
}

export default function AboutPage({ onBack }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", overflowY: "auto" }}>
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
          lineHeight: 1.3, margin: "0 0 1rem", textWrap: "balance",
        }}>
          Your genetics — in language you can understand, a format you can
          talk to, and visuals that show what the numbers mean.
        </h1>

        <P>
          {/* "Sources shown" left the headline and kept its meaning: the triad
              is about the experience, and traceability is the proof, which
              belongs in the sentence that can afford to be specific. Losing it
              entirely would have dropped the strongest claim on the page. */}
          Welcome to MyDNA — an independent project, built by one person, for
          anyone who wants to understand their own genetics, or to dig into
          genetic research without needing a specialized interface. Ask it
          questions in your own words. It reads data you already have,
          answers in plain language, and shows where every answer came from.
        </P>

        <Section title="Why it exists">
          {/* First person, and deliberately. This section was third person on
              the rule that MyDNA is the subject rather than the person who
              built it — which is right for every other section and wrong for
              this one. The story is the founder's and only carries in his own
              voice. The rest of the page stays third person; the seam is
              intentional, not an oversight. */}
          <P>
            <strong style={{ fontSize: "1.35rem", color: "var(--text)" }}>40.</strong>{" "}
            That&rsquo;s the number of days my mother had from her diagnosis to
            the day she passed. It felt like an eternity in the midst of it, yet
            when it was over, an instant.
          </P>
          <P>
            It was a rare and aggressive leukemia, accelerated by a handful of
            genetic mutations we still know too little about. This was in 2023;
            70 years after the discovery of the double helix, 20 years after the
            completion of the Human Genome Project, and 10 years after CRISPR
            was first used to edit human cells.
          </P>
          <P>
            There is something beautiful about the mystery of the human body.
            Something so complex it feels impossible to fully understand, and
            yet discovery upon discovery yields a clearer picture of who we are,
            how we are put together, and — for some — even why we are here. That
            path is accelerating, and technology is why.
          </P>
          <P>
            We are held back less by a shortage of data than by the
            communication needed to make use of it. MyDNA is simply an
            expression of hope: that new relationships, in the data and among
            the people reading it, will lead to discoveries about ourselves and
            ultimately change the world.
          </P>
        </Section>

        <Section title="The problem is not a shortage of data">
          <P>
            There is an enormous amount of genetic research in public
            databases, and almost none of it is written for the person it
            describes. The difficulty is structure — findings split across
            institutions that use different identifiers, held behind
            interfaces built for specialists, with real relationships between
            them left unconnected because nothing joins the databases
            together.
          </P>
          <P>
            That is not a hypothesis. While MyDNA was being built, half of its
            sources were quietly returning nothing at all — not broken, just
            answering with less and less. MyDNA checks every source, every week,
            against things already known to be true, and lets you know.
          </P>
        </Section>

        <Section title="What it actually does">
          <P>
            Every answer is assembled from live queries to public research
            databases, not from a model&rsquo;s memory. Each response names the
            sources it reached and says which ones it could not, so &ldquo;no
            data&rdquo; stays distinguishable from &ldquo;could not ask&rdquo;.
            Findings link back to the record they came from, so anything here
            can be checked against the original.
          </P>
          <P>
            MyDNA holds no genetic research of its own. It is, in the
            founder&rsquo;s words, just a better shell — the science belongs to
            the institutions that produced it, and the job here is to make it
            legible.
          </P>
          <P>
            The realistic alternative most people reach for is searching their
            symptoms and reading whatever comes back, unsourced and
            uncredited. This is meant to be the version you can verify. It is
            worth saying plainly that the model can still be wrong, which is
            exactly why every claim is traceable.
          </P>
        </Section>

        <Section title="What it is not">
          <P>
            <strong style={{ color: "var(--text-secondary)" }}>
              MyDNA is not medical advice and does not diagnose anything.
            </strong>{" "}
            Speak to your clinician about your personal situation. Where a
            clinical genetic test exists for a gene, MyDNA will tell you it
            exists — that is information, not a recommendation.
          </P>
          <P>
            MyDNA also does not test your DNA. It reads a file you already have
            from a consumer testing service, and it works without one.
          </P>
        </Section>

        <Section title="Who it is for">
          <P>
            People trying to understand a diagnosis, or holding a raw data file
            with no way to ask for more. Researchers and students wanting to
            eliminate the scavenger hunt required to compile numerous sources.
            In some cases, the visualizations are better than what the source
            databases offer on their own.
          </P>
        </Section>

        <Section title="Why it costs anything">
          <P>
            Subscriptions cover hosting and the AI tokens each answer consumes.
            MyDNA does not sell data, and the reason it can afford not to is
            that the people using it pay for it instead.
          </P>
          <P>
            Free, donation-funded and open source is the direction. How to get
            there is not solved yet. The first task was finding out whether the
            tool could work, become useful, and be beautiful.
          </P>
        </Section>

        <Section title="Where the answers come from">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {SOURCES.map(s => (
              <span key={s} style={{
                fontSize: "0.68rem", padding: "0.2em 0.55em", borderRadius: 100,
                background: "rgb(var(--c-surface) / 0.6)",
                border: "1px solid rgb(var(--c-border) / 0.35)",
                color: "var(--text-dim)",
              }}>{s}</span>
            ))}
          </div>
          <p style={{ fontSize: "0.72rem", color: "var(--text-dim)", lineHeight: 1.6, marginTop: "0.9rem" }}>
            Public research databases maintained by NCBI, EMBL-EBI, the Broad
            Institute, UniProt, the Monarch Initiative and others. Explanations
            are written by Claude, from the data those sources return.
          </p>
        </Section>

        <div style={{
          marginTop: "2.5rem", paddingTop: "1.25rem",
          borderTop: "1px solid rgb(var(--c-border) / 0.3)",
        }}>
          <p style={{ fontSize: "0.72rem", color: "var(--text-dim)", lineHeight: 1.6, margin: 0 }}>
            For research and educational purposes only. Not a substitute for
            professional medical advice, diagnosis, or genetic counselling.
          </p>
        </div>
      </div>
    </div>
  );
}
