# Legal drafts — open items

`privacy-policy.md` and `terms-of-use.md` are **drafts written from an audit of
what the code actually does**, not templates. They are not legal advice and have
not been reviewed by a lawyer. Genetic data plus paying customers plus EU/UK and
California users is a combination where a review is worth the money.

Every factual claim in them was checked against the schema and the request path.
Where a claim could not be verified, the document says so rather than guessing.

---

## Resolved

| Item | Decision |
|---|---|
| Controller | **Red Wolf Agency**, 1844 Jose Way, Murfreesboro, TN 37130, United States |
| Contact | **info@redwolfagency.co** |
| Governing law | Tennessee |
| Minimum age | **18** — and uploading a child's genetic data is prohibited outright, since it describes a person for life and is not a consent to give on someone else's behalf |
| Refund window | 14 days |
| Liability cap | Fees paid in the preceding **6 months** |
| Query retention | 90 days for stored answers |
| Anonymous queries | **No longer stored.** Signed-out visitors leave no row at all |
| Consent | **Recorded** as a bare timestamp on the account (`dna_consent_at`); nothing for signed-out visitors |
| Export & erasure | **Built and self-serve** — Settings → Your Data. `GET /user/export`, `DELETE /user/account`, 12 tests |
| OMIM | Disconnected rather than licensed — see `data-source-licensing.md` |

## Blockers — still outstanding

**1. EU and UK representatives (Article 27).** The one genuinely unresolved
question. A controller established outside the EU that offers services to
people there must appoint an EU representative, and the exemption for
occasional, low-risk processing **does not apply to special-category data** —
which genetic data is. UK GDPR imposes the same requirement separately.

Three options, all defensible, none free:

- **Appoint them.** Commercial services run roughly €200–500/year each.
- **Do not offer the service in the EU/UK.** No representative needed if you
  genuinely do not target those users. Means geo-blocking, and saying so.
- **Accept the risk knowingly.** Common for projects this size. It is a gap,
  not an oversight, and it should be a decision rather than a default.

The policy currently carries a visible `[DECISION PENDING]` marker at section 1.
It should not be published with that marker still in it.

**2. Data processing agreements.** GDPR Article 28 requires one with every
processor. Two of the four are already settled — **verified, not assumed**:

- **Anthropic** — *nothing to do.* The DPA "is incorporated into these Terms by
  reference" in the Commercial Terms. There is no console page to find, which
  is why looking for one turned up nothing. Those same terms also state
  **"Anthropic may not train models on Customer Content from Services"**, which
  applies to API access generally rather than being an enterprise benefit — so
  the policy now cites it directly.
- **Stripe** — *nothing to sign.* The DPA "is subject to and forms part of the
  Agreement". It relies on the EU–US Data Privacy Framework, SCCs Modules 1 and
  2, and the UK International Data Transfer Addendum. Section 6 of the policy
  now names all three.

Still to confirm: **Railway** and **Vercel**. Both publish standard DPAs; check
whether they are incorporated automatically or need accepting, and note which
transfer mechanism each names so section 6 can state it.

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
