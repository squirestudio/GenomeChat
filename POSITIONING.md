# Positioning

What MyDNA is, who it is for, and the words used to say so. Kept because these
decisions get re-litigated otherwise, and because several were made by rejecting
a nearly-identical alternative for a specific reason worth remembering.

**Status:** working document. Updated 2 August 2026.

---

## The tagline

> ## Ask your DNA Anything

Chosen 2 August 2026 over eleven alternatives. Four words, active voice, and it
does something none of the others did: **it tells the reader what to do.** That
matters because the empty state's main failing was never explaining how to
start. It also opens a tutorial naturally — *"Ask your DNA Anything. Here's
how."* — and it survives the product's honest limits, because "ask" never
promises an answer about your health.

Live in the header, the browser title, and the first card of the tour. The three
must stay in the same casing: two spellings of a tagline read as a typo.

**Runner-up, kept in reserve:** *"Your DNA, explained — with receipts."* Leads
with traceability, which is the strongest differentiator and the least used.
"Receipts" does the whole 26-source argument in one word nobody has to decode.

### Rejected, and why the reasons still apply

| Candidate | Why not |
|---|---|
| *Genetics Simplified* | "Simplified" implies the content is reduced. The design commitment is the opposite: only the language simplifies, never the findings. Same defect as the reading-level label "Precise". |
| *Simple, Safe, Validated, and Fun* | **"Fun"** sits badly beside someone researching their child's diagnosis, and undercuts the not-a-medical-service positioning. **"Safe"** and **"Validated"** read as efficacy claims in a health context — the kind of words that invite a regulator to ask what was validated against what. |
| *Personalizing your DNA Results* | MyDNA does not produce results. The reader brings their own file; MyDNA explains public research. This sentence describes a testing company. |
| *A Conversation with your genetics* | Close to the chosen line but passive. "Ask" is an instruction; "a conversation" is a description. |

---

## The positioning statement

The founder's formulation, kept as the **internal thesis** because it is accurate
and names the three real capabilities:

> A genomics interface that uses aggregation, visualization, and communication to
> propel forward the researcher and curious consumer alike.

**Not used as public copy**, for one reason worth stating: it reads like a grant
abstract, in exactly the register the product spent a day moving away from.
"Interface" is cold, "propel forward" is vague, and it is eighteen words. A
product that commits to plain English should not need decoding in its own
description.

The same content, public-facing:

> **MyDNA brings 26 public genomic databases together, shows you what they say,
> and explains it in plain English — whether you're a researcher or just
> curious.**

Or as three verbs, for tight spaces:

> **Aggregates the research. Shows the picture. Explains it plainly.**

The tagline is the invitation; this is the paragraph underneath it.

---

## What MyDNA is, in order of what makes it different

1. **It shows its work.** Every answer traces to named public databases, and
   where curators disagree it says so rather than picking a winner. This is the
   strongest asset and the most under-communicated — the footer names six
   sources out of twenty-six.
2. **It explains rather than reports.** Plain English by default, with the
   technical register available on request. The findings are identical at both
   settings; only the wording changes.
3. **You bring your own data, and it stays yours.** DNA and documents are parsed
   in the browser, held for the session, never stored. Not a marketing claim —
   a load-bearing property of the code, enforced by tests.
4. **It refuses to diagnose.** Two independent guards, and the refusal is
   informative rather than a dead end: a diagnostic question returns the data
   relationship plus the limit.

## What MyDNA is not

- **Not a test.** It never sequences anything. The reader supplies a file.
- **Not a medical service.** It does not diagnose, prognose, or advise on
  treatment, and says so on the page rather than only in the Terms.
- **Not a research database.** It queries other people's data and holds none of
  its own — which is also why anyone could rebuild it.
- **Not a charity.** Contributions are taxable income to a sole proprietorship,
  not deductible gifts. See "Supporting MyDNA" in the Terms.

---

## Audience

Two, deliberately, and the product serves both with one artefact rather than
two products:

- **The curious reader** — usually here about their own health or a family
  member's. Gets plain language by default, prevalence separated from carrier
  frequency, and an explicit refusal to diagnose.
- **The researcher or clinician** — gets the same data with the terminology
  unglossed, effect sizes stated, and evidence traceable to PMIDs.

The reading-level setting is what makes one product serve both. Its two options
are **Plain English** and **Clinical** — "Clinical" names an audience rather than
ranking quality, so neither label disparages the other.

---

## Sustainability, and the long-term shape

The stated goal is a tool that **outlives its creator and sustains itself**, not
a profit-generating product. Three things already point that way and one does
not yet:

- **BYOK is decentralisation, already shipped.** A reader with their own
  Anthropic key pays the provider directly and costs MyDNA nothing.
- **No data moat, by construction.** All sources are public. Anyone can rebuild
  this; the value is the aggregation and the language, not hoarded data.
- **Two independently deployable apps** with a working compose file, so
  self-hosting is a documentation problem rather than an architectural one.
- **Not yet: a structure that survives the founder.** Open Collective fiscal
  hosting is the conventional answer and solves the tax problem in passing —
  contributions stop being personal income. Worth looking at before the support
  button attracts much.

Crypto and on-chain models were considered and set aside: they add regulatory
surface and solve nothing that open source, self-hosting, BYOK and fiscal
hosting do not already solve.

### Pricing, measured

All figures from billed token usage and live Stripe prices, not estimates.
Stripe takes 2.9% + 30c, which is why pack size matters as much as pack price.

| | Gross | Net | Against cost |
|---|---|---|---|
| **Credits** (200) | $5.00 | $4.55 | $0.0228/credit vs **$0.0128** per query = **1.78x** |
| **Unlimited** | $10.00/mo | $9.41 | break-even at **735 queries/month** — about 25 a day |
| **BYOK** | $25.00 once | $23.98 | the reader then pays Anthropic directly; your cost for them goes to ~$0 |

**Measured costs.** A question is **$0.0128** — 4,617 input and 1,639 output
tokens on Haiku 4.5. A scanned page is **$0.047**: 4,843 input tokens once the
image is encoded, plus ~2,200 of transcription on Sonnet. A section fetch is
**$0.00**, because it calls no model at all.

**What that bought, and what it cost.**

- **Sections are free.** They were charging a credit for zero marginal cost —
  the one line in the pricing that could not be defended.
- **Scans cost 4 credits.** First set at 2 on an estimate of ~$0.03. The real
  figure is $0.047, so two credits *lost money on every page* — netting $0.046
  against $0.047. Four puts a scan at roughly the same 1.8x as a query.
- **The subscription is the healthy shape.** A one-time unlock meant a heavy
  user cost money indefinitely against a single payment; $10/month recurs with
  the usage it funds.
- **BYOK is the best product on every axis.** Highest margin, and it is the
  decentralisation lever: the reader pays the model provider directly and MyDNA
  costs nothing to serve them.

**Who subsidises whom.** A fully-consumed free tier is 20 queries = **$0.26**.
One credit pack funds about **8** such users. One BYOK sale funds about **94**.
Against roughly $6/month of hosting, the free tier is comfortably affordable —
which was the goal, rather than margin.
