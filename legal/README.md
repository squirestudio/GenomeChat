# Legal drafts — open items

`privacy-policy.md` and `terms-of-use.md` are **drafts written from an audit of
what the code actually does**, not templates. They are not legal advice and have
not been reviewed by a lawyer. Genetic data plus paying customers plus EU/UK and
California users is a combination where a review is worth the money.

Every factual claim in them was checked against the schema and the request path.
Where a claim could not be verified, the document says so rather than guessing.

---

## Blockers — the policy cannot be published without these

**1. A contact address.** Both GDPR and the CCPA require a route to exercise
rights. There is currently none, and a privacy policy that describes rights with
no way to invoke them is worse than no policy: it documents non-compliance.
`privacy@mydna.chat` forwarding to your inbox is enough.

**2. A legal entity name and address.** GDPR requires the controller to be
identifiable. "MyDNA" alone will not do — it needs whatever the operating entity
is, even if that is a sole trader in your own name.

**3. The premise "we do not collect data from visitors" is not accurate.**
Worth stating plainly because it shaped the brief:

- Signing in stores **email and name**
- **Every question is stored**, including from visitors who never sign in —
  `queries` rows with `user_id IS NULL`. The text, the gene, the full answer
  payload, the sources and a timestamp
- Stripe customer references are stored for subscribers

None of that is unusual or wrong, and none of it is sold or shared. But it is
collection, and the policy has to describe it. **Decision needed:** keep storing
anonymous queries (they power history within a session and are useful
operationally), or stop? If they stay, they stay described.

## Rights you have promised but cannot yet fulfil

There is **no account deletion endpoint and no data export endpoint** — only key
deletion exists. For a project this size, fulfilling requests **manually** is
legitimate and common, and the drafts are written on that basis. But:

- Someone has to actually be able to do it. There is no admin tooling, so it
  means running SQL against production.
- The 30-day (GDPR) and 45-day (CCPA) response windows are commitments.

If self-serve is wanted later, `DELETE /auth/me` and `GET /auth/export` are
small additions. Not urgent; do mean it in the meantime.

## Consent is not recorded

DNA processing relies on **explicit consent** — Article 9 GDPR, since genetic
data is special category, and CPRA sensitive personal information. The consent
screen exists and is shown before any file is read, which is the substance of it.

But consent is handled **entirely client-side and never recorded**, so there is
no evidence it was given. GDPR expects a controller to be able to demonstrate
consent. Nothing about your current flow is unfair to users — the gap is
evidential.

The awkward part: recording consent means storing a record *about* a person's
genetic-data use, which cuts against the privacy posture. A defensible middle is
a timestamped record against the account only (`consented_at`), with no variant
data, and nothing at all for anonymous users. Worth a decision rather than a
default.

## Licensing on the data sources

Now tracked in `data-source-licensing.md`, which records the terms for all
twenty sources and the reasoning behind each call.

**OMIM was disconnected on 2026-07-30** rather than licensed. It is free for
academic and research use and **commercial use requires a licence** from Johns
Hopkins, which a paid subscription plausibly needs. The cost of removing it was
measured first: across six genes it contributed three disease names that
ClinGen, Monarch, HPO and MedGen did not already cover, and populated an
inheritance mode for 2 of 30 phenotypes where ClinGen managed every gene. What
was genuinely lost is MIM numbers as identifiers. The fetcher and its tests are
intact, so a licence would make it a two-line restoration.

**ClinPGx (formerly PharmGKB)** carries CC-BY-SA terms on parts of its data,
with restrictions on commercial redistribution. It remains connected, on the
reading that displaying attributed annotations differs from redistributing a
dataset — but confirm before pharmacogenomics becomes a headline feature.

Everything else is clear for commercial use with attribution, which the product
gives in the footer, on `/about`, and in each answer's source list.

## Decisions needed in the drafts

Marked `[LIKE THIS]` in both files:

| Item | Note |
|---|---|
| Minimum age | 16 aligns with GDPR consent thresholds; 18 is simpler for a health-adjacent tool |
| Governing law / jurisdiction | Where you are |
| Refund window | "At our discretion" is honest but a stated window, e.g. 14 days unused, reads better and reduces disputes |
| Liability cap amount | Usually fees paid, or a small fixed floor |
| Query payload retention | Policy says 90 days, matching the default. **Note the earlier finding: the oldest stored answer was already 108 days old, so the default will prune real rows.** Set `QUERY_PAYLOAD_RETENTION_DAYS` deliberately and make the policy match |

## Worth confirming with processors

- **Anthropic** — API inputs are not used for training by default, and there is a
  zero-retention option for eligible accounts. The policy's claim that variants
  are not used for training rests on this; worth confirming it matches your
  account terms.
- **Data processing agreements** with Anthropic, Stripe, Railway and Vercel.
  GDPR Article 28 requires them where a processor handles personal data on your
  behalf. All four publish standard DPAs.
- **Transfer mechanism** per processor — SCCs and/or Data Privacy Framework — so
  section 6 of the policy can name it rather than gesture at it.

## What is genuinely strong here

Worth knowing, since it is unusual and the policy should not undersell it:

- **No cookies, no analytics, no trackers, no pixels.** Verified — none in the
  codebase. Most privacy policies cannot say this.
- **DNA files are never uploaded.** Parsing is client-side; relevance matching is
  client-side. Only the handful of variants relevant to a question travel with
  it, and they are never written to the database.
- **IP addresses are never persisted** — rate limiting holds them in memory only.
- **No data sale, ever**, and the business model does not depend on one.
- **Access control returns "not found" rather than "forbidden"** for another
  user's records, so they cannot be enumerated.

That is a stronger position than most funded competitors, and stating it plainly
is more persuasive than any assurance.
