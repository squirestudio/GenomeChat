# Legal documents — decision log

`privacy-policy.md` and `terms-of-use.md` are **written from an audit of what
the code actually does**, not from templates.

**Reviewed and approved 4 Aug 2026.** The founder confirmed legal review is
complete and is re-reviewing himself; the "draft pending legal review" line came
out of both documents, and the dates were moved to 4 August because that same
pass materially changed them — the postal address, the Tennessee operating-state
clause, the full list of databases that receive the queried gene, and the
corrected rsID recipient disclosure. Terms §17 promises a revised date on
material change, so leaving 30 July would have broken a commitment the document
makes about itself.

**This file is not published** and should not be linked from either document —
it is the reasoning behind them, including options that were rejected, and it
names things (the full legal name, the unshipped entity plan) that deliberately
appear nowhere on the site. The privacy policy used to point readers here; that
line is gone with the draft notice.

Every factual claim in them was checked against the schema and the request path.
Where a claim could not be verified, the document says so rather than guessing.

---

## Resolved

| Item | Decision |
|---|---|
| Controller | **Ben Brown, trading as Squire Studio**, a sole proprietorship, Tennessee. See "Entity" and "How the name shortens" below |
| Contact | **support@mydna.chat** for everything about MyDNA, **privacy@mydna.chat** for data rights only. One general address on purpose — a second inbox is a triage tool, and an unmonitored one is worse than none; `hello@` earns its place when partnership mail arrives often enough to cost time, not before — kept separate so a rights request cannot go unanswered in a support queue. Both Namecheap forwarders; MX, SPF and DMARC `p=reject` verified 3 Aug 2026. Old row: **privacy@mydna.chat** — live, forwarding verified 1 Aug 2026. DMARC `p=reject` set |
| Postal address | **5013 S Louise Ave, Unit #803, Sioux Falls, SD 57108** — a CMRA, live 4 Aug 2026. Published in privacy §1 and terms §18. Deliberately not a residence; see "Entity" below. Cheapest non-residential option, not a domicile move — **both documents state that MyDNA is operated from Tennessee** so the out-of-state address cannot be misread |
| Governing law | **Tennessee** — where the operator actually is, which is what makes the clause hold. See "Which state" below |
| Minimum age | **18** — and uploading a child's genetic data is prohibited outright, since it describes a person for life and is not a consent to give on someone else's behalf |
| Refund window | 14 days |
| Liability cap | Fees paid in the preceding **6 months** |
| Query retention | 90 days for stored answers |
| Anonymous queries | **No longer stored.** Signed-out visitors leave no row at all |
| Consent | **Recorded** as a bare timestamp on the account (`dna_consent_at`). DNA upload now **requires sign-in**, so every processing event has a consent record behind it |
| Article 27 | **No EU/UK representative** — not offered in those regions; stated in the Terms |
| Railway DPA | **Signed 30 July 2026** — DocuSign envelope `63268108-745A-4CB1-A5EE-40D110BFE605`, sealed 31 July 02:24 UTC. One completeness gap, below |
| Export & erasure | **Built and self-serve** — Settings → Your Data. `GET /user/export`, `DELETE /user/account`, 12 tests |
| OMIM | Disconnected rather than licensed — see `data-source-licensing.md` |

## Entity — the position as of 31 July 2026

Squire Studio is an informal trading name. Red Wolf Agency is a sole
proprietorship. **Neither is a separate legal entity**, so both resolve to
one legal person, Benjamin Kenneth Brown, and there is no inconsistency between accounts to
reconcile — there was never a second party to be inconsistent with. The Railway
DPA was signed by the correct legal person regardless of which account name it
sits under, and switching the published name does not affect it.

**MyDNA is published under Squire Studio**, which is the lab where products
ship (Tik Attack Toe, SudoSwap); Red Wolf Agency is the client-work side and is
expected to act as MyDNA's marketing agency later. The distinction carries no
legal weight while both are the same person, but it decides the name that ends
up in archived pages and shared links, and it matches the accounts that already
exist — GitHub, email and the rest are Squire Studio already, so this aligns
the paperwork to reality rather than the reverse.

Because Squire Studio is *informal* rather than a registered assumed name, the
documents name a person as well: **"Ben Brown, trading as Squire Studio"**. A
controller must be identifiable as a legal person, and an unregistered trading
name alone identifies nobody.

### How the name shortens

The published documents say "Ben Brown", not the full legal name, decided
1 Aug 2026. Nothing requires a middle name — the obligation is that the
controller be *identifiable*, not that every given name appear — and "Ben" is
the form he is known by, corroborated by the domain registration and by
privacy@mydna.chat. Initials were considered and rejected: on a privacy policy
specifically, an obscured identity works against the one job that line has.

The site footer names no person at all, only Squire Studio. It never needed to
— the controller is identified in section 1 of both documents, and the footer
was belt-and-braces.

Two steps remain, and both shorten it further:

1. **Register the assumed name** with the county register of deeds (Tennessee
   routes sole proprietors to the county, not the Secretary of State). Cheap,
   and arguably overdue on its own terms since trading under an unregistered
   assumed name is a technical problem in its own right. Once it is a public
   record, "Squire Studio" resolves to a person through a searchable filing and
   the documents can lead with the studio name.
2. **Form the LLC** — see "Entity" above. An LLC *is* a legal person, so the
   controller becomes the company and no personal name appears on the site at
   all. This is the real answer: the naming preference and the missing
   liability shield have the same fix.

**Whichever happens, re-paper Railway and Stripe in the same pass.** The
Railway DPA is executed by the individual and the Stripe account name reaches
customers' bank statements; a policy naming an entity that neither document
knows about is exactly the inconsistency flagged under "Railway" below.

The consequence is that **there is currently no liability shield**. A claim
arising from MyDNA is a claim against personal assets. That is an ordinary
position for a side project and a slightly poor one for a paid service handling
genetic data and publishing health-adjacent information. The disclaimers in the
terms allocate risk well; they cannot absorb it.

Recommended, in order:

1. ~~**A PO box, CMRA or registered agent.**~~ **Done, 4 Aug 2026** — a CMRA at
   5013 S Louise Ave, Unit #803, Sioux Falls, SD 57108, published in section 1
   of the privacy policy and section 18 of the terms. No residence appears
   anywhere, and the draft banner came off with it.
   **It still cannot accept service of process.** A CMRA is sufficient for a
   contact address — Railway's own address in the DPA we signed is a PMB — but
   if an LLC follows, its registered agent covers the registered office and
   service of process for similar money, so do not buy a second service before
   deciding the entity question below.
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

### Which state — resolved 4 Aug 2026: Tennessee

The CMRA is in **Sioux Falls, South Dakota**; every jurisdictional statement in
these documents says **Tennessee**. Confirmed with the founder: **Tennessee is
the real base.** The South Dakota box was the least expensive way to get a
non-residential address, and nothing more — not a domicile move.

So nothing about the entity plan changes. Governing law stays Tennessee, the
assumed-name filing stays with the county register of deeds, and an LLC would be
a Tennessee LLC.

**Both documents now say so explicitly**, because the inference is not available
to a reader who can only see the SD address: privacy §1 states MyDNA is operated
from Tennessee and that the postal address is for correspondence, and terms §16
opens with the operating state before naming the governing law, with a line
pointing at §18 so the two cannot be read as contradicting each other.

That is the whole fix. **A governing-law clause is on far safer ground when the
named state is where the operator actually is** — the risk was never the mailbox,
it was a reader or a counterparty finding only a South Dakota address and no
stated connection to Tennessee anywhere in the documents.

One consequence to remember: **a CMRA cannot accept service of process.** That is
unchanged and is now the only thing the address does not do. A Tennessee LLC's
registered agent covers it, which is one more reason the LLC is the real answer.

## Decisions taken, and why

**1. EU and UK representatives (Article 27) — resolved 31 July 2026.**

Position taken: **not appointed, on the basis that MyDNA is not offered in the
EEA or the UK.** Article 3(2) applies only where a controller offers services
to people there, and Recital 23 is explicit that a site being merely
*accessible* from the EU does not establish that intention — there must be
evidence of targeting, such as EU currencies, EU languages or region-specific
marketing. MyDNA has none: USD pricing, English only, US-operated, no EU
marketing.

An earlier note here said the "occasional processing" exemption in Article
27(2) is unavailable for special-category data. That was imprecise: the test is
*large-scale* processing of special categories, and a project with a handful of
EU users is plausibly not large scale. The exemption is arguable — but the
targeting point above is the stronger and simpler ground, so the documents rest
on that instead.

The Terms now state the position outright, under "Eligibility and where MyDNA is
offered", and the policy explains why no representative is named. **The data
rights are honoured for everyone regardless of location** — export and erasure
are built and self-serve, so extending them to all comers costs nothing and is
worth more than the narrower position we could have taken.

Revisit if EU signups actually appear, or if pricing, languages or marketing
ever target those regions — at which point representatives cost roughly
€200–500 per year each.

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
