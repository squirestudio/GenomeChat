# Privacy Policy

**DRAFT — not yet reviewed by a lawyer. See `legal/README.md` for the open items that must be resolved before this is published.**

**Last updated:** [DATE]
**Effective:** [DATE]

---

## In short

MyDNA is an independent project. It does not sell your data, does not run
advertising, and does not track you across the web. There are no analytics, no
cookies and no third-party pixels on this site.

Your uploaded DNA file is read **on your device** and is never uploaded or
stored. Only the small number of variants relevant to a question travel with
that question so it can be answered, and they are discarded once it is.

The questions you ask **are** stored, so your history works. So is your email
address if you sign in. Details below.

---

## 1. Who is responsible

MyDNA ("we", "us") is operated by **[LEGAL ENTITY NAME]**, [ADDRESS],
[COUNTRY]. For questions about this policy or to exercise any right described
here, contact **[PRIVACY CONTACT EMAIL]**.

If you are in the UK or EU and we are required to have a representative or Data
Protection Officer, those details will appear here. *(Open item — see
`legal/README.md`.)*

## 2. What we collect

### 2.1 If you sign in

Sign-in uses Google. We receive, and store:

| Data | Why |
|---|---|
| Email address | Identifies your account; the only way to link your history and purchases to you |
| Name (as Google provides it) | Displayed in the interface |
| Account created / updated timestamps | Housekeeping |

We do **not** receive your Google password, contacts, calendar or Drive.

### 2.2 Whether or not you sign in

Every question you ask is recorded, including when you are not signed in:

| Data | Notes |
|---|---|
| The text of your question | Stored as written |
| The gene or condition identified | e.g. `BRCA1` |
| The answer returned, and the data behind it | Stored so your history can be reopened without re-querying |
| Which sources were used, and response timing | Operational and quality purposes |
| Timestamp | |

When you are not signed in these records are stored without an account
identifier. **They are not anonymous in the strict sense** — a question can
itself be identifying, and we would rather say so than claim otherwise.

### 2.3 Payments

If you subscribe or buy credits, **Stripe** processes the payment. We never
see or store your card details. We store a Stripe customer reference so you can
manage or cancel your subscription, plus what you are entitled to (subscription
active, credits remaining).

### 2.4 If you supply your own Anthropic API key

Optional. It is encrypted before storage (AES-256 via Fernet) and is never sent
back to the browser or displayed again. You can remove it at any time.

### 2.5 Technical data

Your IP address is used to apply rate limits and to prevent abuse. **It is not
written to our database.** It exists briefly in memory and in our hosting
provider's standard request logs.

## 3. Your DNA data — handled differently

This is the part most people care about, so it is stated precisely rather than
reassuringly.

**What happens:**

1. You choose a file (23andMe, AncestryDNA or VCF). It is **parsed in your
   browser**. The file itself is never uploaded.
2. Parsed variants are held in your browser's session storage. They are cleared
   when you close the tab or clear the session.
3. When you ask a question, the variants **relevant to that question** — those
   named in it, those inside the gene you asked about, and a small curated
   panel — are sent with the question so it can be answered. Typically tens of
   variants, not your whole file.
4. Those variants are passed to **Anthropic's Claude API** to write the answer.
   They are **not written to our database** at any point.
5. Working out which of your variants sit in a gene happens **in your browser**.
   Nothing is sent to determine relevance.
6. If you choose "look up what these mean", the **rsIDs of those variants only**
   are sent to NCBI's dbSNP. This happens only when you click.

**What we do not do:** store your file, store your variants, build a profile
from them, share them with anyone other than the processors named above, or use
them to train any model.

**Legal basis and sensitivity.** Genetic data is "special category" data under
the UK/EU GDPR (Article 9) and "sensitive personal information" under the
CPRA. We process it **only on your explicit consent**, given through the
consent screen before any file is read, and only to answer the question you
asked. You can withdraw consent at any time by clearing your DNA session — the
× on the DNA banner — which removes it from your browser.

## 4. What we do not collect

- No cookies
- No analytics or telemetry of any kind
- No advertising identifiers, pixels or third-party trackers
- No cross-site or cross-device tracking
- No purchase or sale of personal data from or to data brokers

Your sign-in token is kept in your browser's local storage, not in a cookie,
and is sent only to MyDNA's own API.

## 5. Who else receives data

We use these processors. Each receives only what it needs.

| Processor | Receives | Purpose |
|---|---|---|
| **Anthropic** (Claude API) | Your question, the research data retrieved for it, and any relevant variants | Writing the answer |
| **Google** | Your sign-in request | Authentication |
| **Stripe** | Your email and payment details | Payments |
| **Railway** | Everything stored | Hosting and database |
| **Vercel** | Requests for the site itself | Frontend hosting |

**Public research databases.** To answer a question we query public databases
including ClinVar, Ensembl, gnomAD, UniProt, OMIM, dbSNP, dbVar, HPO, Monarch,
Reactome, GTEx, STRING, Open Targets, the GWAS Catalog, ClinGen, MedGen, GTR,
ClinPGx, NCI GDC, PubMed and PMC. These receive the **gene or condition** being
asked about. They do not receive your identity, your account, or your file. The
one exception is the explicit variant lookup described in section 3, which
sends rsIDs to NCBI.

**We do not sell or share your personal information**, in the ordinary meaning
of those words and as defined by the CCPA/CPRA. We have never done so.

**Disclosure required by law.** We may disclose data if legally compelled. If
that happens we will notify you unless prohibited from doing so.

## 6. International transfers

MyDNA and all processors above are in or route through the **United States**. If
you are in the UK, EU or Switzerland, your data is transferred outside your
jurisdiction. We rely on the processors' Standard Contractual Clauses and, where
applicable, their Data Privacy Framework certifications. *(Open item — the
specific mechanism per processor should be confirmed and named here.)*

## 7. How long we keep things

| Data | Retention |
|---|---|
| Account (email, name, entitlements) | Until you delete your account |
| Your questions and their answers | Stored answers are automatically pruned after **[QUERY_PAYLOAD_RETENTION_DAYS, currently 90]** days; the question, target and sources are kept so your history still lists them |
| Stored Anthropic API key | Until you remove it |
| Payment records | As long as tax and accounting law requires |
| DNA variants | Not retained. Held in your browser session only |
| IP addresses | Not stored by us; hosting logs follow the provider's own retention |

## 8. Your rights

Regardless of where you live, you can ask us to:

- **Tell you** what we hold about you, and give you a copy
- **Correct** anything inaccurate
- **Delete** your account and everything associated with it
- **Export** your data in a portable format
- **Restrict** or **object to** processing
- **Withdraw consent** — for DNA processing, immediately, by clearing your DNA session

If you are in the **UK or EU**, these are your rights under GDPR Articles
15–22, and you may complain to your supervisory authority (in the UK, the ICO)
at any time.

If you are in **California**, you have the CCPA/CPRA rights to know, delete,
correct, and to limit the use of sensitive personal information. Because we do
not sell or share personal information, there is no opt-out to exercise — but
you may still ask us to confirm that. We will not discriminate against you for
exercising any right.

To exercise any of these, contact **[PRIVACY CONTACT EMAIL]**. We will respond
within 30 days (GDPR) or 45 days (CCPA). We do not charge for this.

## 9. Automated decision-making

Answers are generated by a large language model from data retrieved live from
the sources listed above. **No decision about you is made automatically** — MyDNA
does not diagnose, score, rank, or determine anything about you, and it takes no
action on your behalf. Its output is information for you to read and check.

The model can be wrong. That is why every answer names its sources and links
back to the original records.

## 10. Children

MyDNA is not intended for anyone under **[16 / 18 — decide]**, and we do not
knowingly collect data from children. If you believe a child has used it,
contact us and we will delete the records.

## 11. Security

Sign-in tokens are signed and expire. Stored API keys are encrypted at rest.
Access to project and query records is checked against the signed-in account on
every request, and a request for someone else's record returns "not found"
rather than a refusal, so records cannot be enumerated.

No system is perfectly secure, and we will not claim otherwise. If we discover a
breach affecting your personal data we will notify you and the relevant
authority as the law requires.

## 12. Changes

If this policy changes materially we will update the date above and note the
change on the site. Continuing to use MyDNA after that means you accept the
revised policy.
