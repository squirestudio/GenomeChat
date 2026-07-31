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
| Controller | **Red Wolf Agency, a sole proprietorship of Benjamin Kenneth Brown**, Tennessee. See "Entity" below — the mailing address is deliberately unset |
| Contact | **info@redwolfagency.co** |
| Governing law | Tennessee |
| Minimum age | **18** — and uploading a child's genetic data is prohibited outright, since it describes a person for life and is not a consent to give on someone else's behalf |
| Refund window | 14 days |
| Liability cap | Fees paid in the preceding **6 months** |
| Query retention | 90 days for stored answers |
| Anonymous queries | **No longer stored.** Signed-out visitors leave no row at all |
| Consent | **Recorded** as a bare timestamp on the account (`dna_consent_at`). DNA upload now **requires sign-in**, so every processing event has a consent record behind it |
| Railway DPA | **Signed 30 July 2026** — DocuSign envelope `63268108-745A-4CB1-A5EE-40D110BFE605`, sealed 31 July 02:24 UTC. One completeness gap, below |
| Export & erasure | **Built and self-serve** — Settings → Your Data. `GET /user/export`, `DELETE /user/account`, 12 tests |
| OMIM | Disconnected rather than licensed — see `data-source-licensing.md` |

## Entity — the position as of 31 July 2026

Squire Studios is a DBA. Red Wolf Agency is a sole proprietorship. **Neither is
a separate legal entity**, so both resolve to Benjamin Kenneth Brown, and there
is no inconsistency between accounts to reconcile — there was never a second
party to be inconsistent with. The Railway DPA was signed by the correct legal
person regardless of which account name it sits under.

The consequence is that **there is currently no liability shield**. A claim
arising from MyDNA is a claim against personal assets. That is an ordinary
position for a side project and a slightly poor one for a paid service handling
genetic data and publishing health-adjacent information. The disclaimers in the
terms allocate risk well; they cannot absorb it.

Recommended, in order:

1. **A PO box or registered agent.** A sole proprietorship's address is a home
   address, and the privacy policy publishes it permanently to an audience
   explicitly invited to read it. The address is left as `[MAILING ADDRESS]`
   rather than filled with a home address. **Both documents are unpublishable
   until it is set.**
2. **A Tennessee LLC**, before the legal pages go live — publishing terms is the
   point at which the operation is visibly a business.
3. **A separate bank account** for it, or a single-member LLC can be pierced for
   commingling and the protection is illusory.
4. **Then** move Stripe and Railway, and re-execute the Railway DPA with
   Exhibit B completed.
5. Tech E&O insurance is worth pricing alongside the LLC; for a solo operator it
   is often the more practical protection, and they complement each other.

Renaming the GitHub organisation, the email addresses or anything in the code
changes no legal fact and is not worth doing.

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

- **Vercel** — *nothing to do.* The addendum "shall become legally binding upon
  Customer entering into the Agreement", so it already binds. Transfers use the
  2021 SCCs (Module Two), governed by Irish law, with the UK IDTA in Schedule 5
  for UK transfers.

**Railway — signed 30 July 2026.** Executed by both parties: Benjamin Kenneth
Brown (Founder/Owner) and Christian Ohrgaard (Head of Operations, Railway).
DocuSign envelope `63268108-745A-4CB1-A5EE-40D110BFE605`, digitally sealed
31 July 2026 02:24 UTC. Transfers rely on the Data Privacy Framework or the
EU/UK SCCs. Keep the PDF with the company records; it is not in this repo.

> **Outstanding: the customer entity is never named in the document.**
>
> "Red Wolf Agency" appears nowhere in it, and **Exhibit B — which is Annex I
> of the Standard Contractual Clauses — has the data exporter's Name, Address
> and Contact information left blank.** The SCCs require both parties to be
> identified; the importer side is complete, the exporter side is not.
>
> The DPA still binds, because section 1 defines Customer as "the Customer
> entity that is a party to the Agreement" — it inherits whoever holds the
> Railway account. **So the fix depends on one fact: whose name is the Railway
> account in?**
>
> - **Red Wolf Agency** — then the DPA binds Red Wolf Agency, matching the
>   controller named in the privacy policy. Ask Railway to re-issue with
>   Exhibit B completed for tidiness, but nothing is actually wrong.
> - **Benjamin Brown personally** — then the DPA's controller is an individual
>   while the privacy policy names Red Wolf Agency. That inconsistency is worth
>   resolving before publishing: either move the Railway account to the
>   company, or name the individual as controller in the policy.
>
> Not urgent, and not a reason to hold anything up. It is the sort of thing
> nobody looks at until a regulator does, and then looks at closely.

### Railway DPA — what a read of it turned up

Not a legal opinion. Nothing predatory or unusual was found; it is a
conventional, processor-favourable hosting DPA, and **the larger risk is not
signing it**, since Article 28 requires a written contract with a processor and
Railway holds the database.

Standard and unremarkable: the indemnity is narrowly scoped to supplying
unlawful or inappropriate data, liability defers to the Terms already accepted,
and return-or-delete on termination is GDPR working in our favour.

Three things worth remembering afterwards:

1. **No 72-hour breach commitment** — only "without undue delay". Article 33
   gives *us* 72 hours from awareness, so a slow notification eats our clock.
   Common, and the reason to watch their status page rather than wait to be
   told.
2. **Sub-processor objection has no teeth.** Ten days' notice, objection on
   data-protection grounds, and if they will not accommodate it the only
   remedy is to leave, without fee relief.
3. **Audits are at our cost**, including reimbursing Railway's staff time, once
   a year, in business hours. Theoretical at this size — in practice we rely on
   their certifications.

**Section 11.1 puts the consent record on us**, for each data subject. That is
what prompted requiring sign-in before DNA upload: previously a signed-out
visitor could load a file whose variants transited Railway's infrastructure
with no consent record anywhere. Transient and unstored, but a gap in this
clause. Now closed by construction rather than by argument.

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
