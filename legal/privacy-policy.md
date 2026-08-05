# Privacy Policy

**Last updated:** 4 August 2026
**Effective:** 4 August 2026

---

## In short

MyDNA is an independent project. It does not sell your data, does not run
advertising, and does not track you across the web. There are no analytics, no
cookies and no third-party pixels on this site.

Your uploaded DNA file is read **on your device** and is never uploaded or
stored. Only the small number of variants relevant to a question travel with
that question so it can be answered, and they are discarded once it is.

Documents you upload are treated the same way: read for the session, never
stored, never added to any shared library. PDFs with selectable text are read
without leaving your device at all.

If you sign in, the questions you ask are stored so your history works, along
with your email address. **If you are not signed in, we store nothing at all.**

Details below, including the parts that are less flattering.

---

## 1. Who is responsible

MyDNA ("we", "us") is operated by **Ben Brown, trading as Squire Studio**, a
sole proprietorship. Postal address:

> Squire Studio
> Ben Brown
> 5013 S Louise Ave, Unit #803
> Sioux Falls, SD 57108
> United States

That is a mail-handling address for correspondence. **MyDNA is operated from
Tennessee, United States**, which is where the responsible person is based.

For questions about this policy or to exercise any right described here,
contact **privacy@mydna.chat** — email reaches us faster than post.

We have not appointed a Data Protection Officer. Our processing does not meet
the Article 37 thresholds that require one — we are a single-person operation
and do not monitor individuals systematically or at scale.

**EU and UK representatives.** We have not appointed one. MyDNA is operated
from the United States and is not directed at users in the EEA or the UK — see
"Eligibility and where MyDNA is offered" in the Terms of Use — so Article 27
does not apply.

We nonetheless honour the rights set out in section 9 for anyone who asks,
wherever they are. If that position changes, or if we begin offering MyDNA in
those regions, we will appoint representatives and name them here before doing
so.

## 2. What we collect

### 2.1 If you sign in

Sign-in uses Google. We receive, and store:

| Data | Why |
|---|---|
| Email address | Identifies your account; the only way to link your history and purchases to you |
| Name (as Google provides it) | Displayed in the interface |
| Account created / updated timestamps | Housekeeping |

We do **not** receive your Google password, contacts, calendar or Drive.

### 2.2 If you are signed in — your questions

Questions asked **while signed in** are stored against your account, so your
history works:

| Data | Notes |
|---|---|
| The text of your question | Stored as written |
| The gene or condition identified | e.g. `BRCA1` |
| The answer returned, and the data behind it | Stored so your history can be reopened without re-querying |
| Which sources were used, and response timing | Operational and quality purposes |
| Timestamp | |

### 2.3 If you are not signed in

**We store nothing.** Questions asked without an account are answered and not
recorded — no text, no answer, no timestamp, no row of any kind.

They previously were stored without an account identifier. That was changed
deliberately: a question can itself identify the person asking it, and keeping
a record of what someone asked before they had agreed to anything was not a
position worth defending. You have no history in that mode, because there is
nothing to show.

### 2.4 Payments

If you subscribe or buy credits, **Stripe** processes the payment. We never
see or store your card details. We store a Stripe customer reference so you can
manage or cancel your subscription, plus what you are entitled to (subscription
active, credits remaining).

### 2.5 If you supply your own Anthropic API key

Optional. It is encrypted before storage (AES-256 via Fernet) and is never sent
back to the browser or displayed again. You can remove it at any time.

### 2.6 Technical data

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
from them, or share them with anyone other than the processors named below.

**Legal basis and sensitivity.** Genetic data is "special category" data under
the UK/EU GDPR (Article 9) and "sensitive personal information" under the
CPRA. We process it **only on your explicit consent**, given through the
consent screen before any file is read, and only to answer the question you
asked.

**Using your DNA requires an account.** Not as a paywall — the feature is
included in the free allowance — but because consent to process genetic data
has to be recorded against someone, and a signed-out visitor is no one we can
attach a record to.

We record **the date and time you gave that consent** and nothing else: no
variants, no file, no record of what you then looked at. Article 7(1) requires
a controller to be able to demonstrate consent rather than merely assert it,
and a timestamp is the least we can store while still meeting that.

Signing in changes who consented. It changes nothing about how your file is
handled — still parsed on your device, still never uploaded, still never
stored.

You can withdraw consent at any time by clearing your DNA session — the × on
the DNA banner — which removes the data from your browser. Withdrawal does not
affect processing already carried out.

**Nothing you send is used to train any model.** MyDNA does not do so, and
Anthropic's Commercial Terms — which govern our API access — state plainly:
*"Anthropic may not train models on Customer Content from Services."* We are
relying on their published terms rather than making a promise on their behalf,
and those terms are at anthropic.com/legal/commercial-terms.

## 4. Documents you upload

You can add your own research material — a PDF of a paper, a photograph of a
journal page — so MyDNA can read it alongside the databases and, if you have
loaded it, your own DNA. This is handled like your DNA data, and for overlapping
reasons: a paper about a particular condition can say as much about your health
as a genome does, because choosing to read it suggests why.

**What happens:**

1. A **PDF with selectable text** is read **entirely in your browser**. The file
   does not leave your device, and reading it costs nothing.
2. A **photograph or scan** has no text to extract. The page image is sent to
   **Anthropic's Claude API** to be transcribed, and is discarded immediately
   afterwards. This is the one path where an uploaded file leaves your device,
   and the upload screen says so before you choose a file. It uses one query
   credit per page.
3. The extracted text is held in your browser's session storage and is cleared
   when you close the tab.
4. When you ask a question, only the **passages relevant to that question** are
   sent with it — chosen by what the question and the gene under discussion
   actually mention, not the whole document.
5. Nothing about your documents is **written to our database** at any point: not
   the file, not the transcription, not the passages.

**Using documents requires an account**, for the same reason DNA upload does:
this is health information, processed on your explicit consent, and consent must
be recorded against someone. The consent record is the same bare timestamp.

**We do not build a library from what you upload.** Your documents are not
added to any shared collection, are not shown to other users, and are not used
to improve results for anyone else. If a feature that pools *citations* — the
DOI or PubMed ID of a paper, which is a fact rather than the paper itself — is
ever introduced, it will be opt-in and described here first.

**Copyright.** Upload only material you have lawful access to. MyDNA reads your
own copy with you for the length of a session; it never stores, republishes or
redistributes it. Nothing here grants you rights in a publisher's work that you
did not already have.

**Nothing you upload is used to train any model** — the same position, and the
same basis, as set out for DNA data above.

## 5. What we do not collect

- No cookies
- No analytics or telemetry of any kind
- No advertising identifiers, pixels or third-party trackers
- No cross-site or cross-device tracking
- No purchase or sale of personal data from or to data brokers

Your sign-in token is kept in your browser's local storage, not in a cookie,
and is sent only to MyDNA's own API.

## 6. Who else receives data

We use these processors. Each receives only what it needs.

| Processor | Receives | Purpose |
|---|---|---|
| **Anthropic** (Claude API) | Your question, the research data retrieved for it, any relevant variants, and relevant passages from documents you uploaded | Writing the answer |
| **Anthropic** (Claude API) | Page images, only when you upload a photograph or scan | Transcribing it to text, then discarded |
| **Google** | Your sign-in request | Authentication |
| **Stripe** | Your email and payment details | Payments |
| **Railway** | Everything stored | Hosting and database |
| **Vercel** | Requests for the site itself | Frontend hosting |

**Public research databases.** To answer a question we query public databases:
ClinVar, Ensembl, gnomAD, UniProt, AlphaFold, dbSNP, dbVar, HPO, Monarch,
Reactome, GTEx, STRING, Open Targets, the GWAS Catalog, ClinGen, GenCC,
Orphanet, MedGen, GTR, ClinPGx, NCI GDC, PubMed, PMC, MedlinePlus,
ClinicalTrials.gov, Genomics England PanelApp, HGNC and Ensembl VEP. These
receive the **gene or condition** being asked about. They do not receive your
identity, your account, or your file.

The one exception is the explicit variant lookup described in section 3, which
sends the rsIDs you chose to look up to **NCBI** (dbSNP) and to **Ensembl**
(the Variant Effect Predictor). Nothing else about you accompanies them.

**We do not sell or share your personal information**, in the ordinary meaning
of those words and as defined by the CCPA/CPRA. We have never done so.

**Disclosure required by law.** We may disclose data if legally compelled. If
that happens we will notify you unless prohibited from doing so.

## 7. International transfers

MyDNA and all processors above are in or route through the **United States**. If
you are in the UK, EU or Switzerland, your data is transferred outside your
jurisdiction.

Each processor's data processing terms are incorporated into the agreement we
hold with them, and each provides a transfer mechanism:

- **Anthropic** — the Anthropic Data Processing Addendum is incorporated by
  reference into their Commercial Terms.
- **Stripe** — EU–US Data Privacy Framework, plus Standard Contractual Clauses
  (Modules 1 and 2 of Commission Decision (EU) 2021/914), plus the UK
  International Data Transfer Addendum.
- **Railway** — Data Processing Addendum, executed separately. Transfers rely
  on the Data Privacy Framework or the EU/UK Standard Contractual Clauses.
- **Vercel** — Data Processing Addendum, binding on entering their agreement.
  Transfers rely on the 2021 Standard Contractual Clauses (Module Two), with
  the UK International Data Transfer Addendum for UK transfers.

## 8. How long we keep things

| Data | Retention |
|---|---|
| Account (email, name, entitlements) | Until you delete your account |
| Your questions and their answers (signed in) | Stored answers are automatically pruned after **90 days**; the question, target and sources are kept so your history still lists them |
| Questions asked signed out | Not stored at all |
| Stored Anthropic API key | Until you remove it |
| Payment records | As long as tax and accounting law requires |
| DNA variants | Not retained. Held in your browser session only |
| Uploaded documents and their text | Not retained. Held in your browser session only |
| Page images sent for transcription | Not retained. Discarded once transcribed; never written to disk or logged |
| IP addresses | Not stored by us; hosting logs follow the provider's own retention |

## 9. Your rights

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

**Two of these you can do yourself, immediately, without asking us:**

- **Export** — Settings → Download my data. Returns everything held about your
  account as a single JSON file.
- **Delete** — Settings → Delete my account. Immediate and irreversible: the
  account, its questions, answers and projects are erased. If you have an
  active subscription, cancel it in Stripe as well — deleting the account
  removes our record of it but does not stop billing.

For anything else about your data, contact **privacy@mydna.chat**. For anything else about MyDNA — partnerships, bugs, billing, or a question — use **support@mydna.chat**. We will respond within 30
days (GDPR) or 45 days (CCPA). We do not charge for this.

## 10. Automated decision-making

Answers are generated by a large language model from data retrieved live from
the sources listed above. **No decision about you is made automatically** — MyDNA
does not diagnose, score, rank, or determine anything about you, and it takes no
action on your behalf. Its output is information for you to read and check.

The model can be wrong. That is why every answer names its sources and links
back to the original records.

## 11. Children

MyDNA is for adults. You must be **18 or over** to use it. We do not knowingly
collect data from anyone under 18, and we do not verify age beyond asking.

If you believe someone under 18 has used MyDNA, contact
**privacy@mydna.chat** and we will delete the records without requiring you
to prove anything.

Uploading a child's genetic data — your own child's included — is not permitted.
Genetic data describes a person for life, and consenting to its processing is
not a decision to make on someone else's behalf here.

## 12. Security

Sign-in tokens are signed and expire. Stored API keys are encrypted at rest.
Access to project and query records is checked against the signed-in account on
every request, and a request for someone else's record returns "not found"
rather than a refusal, so records cannot be enumerated.

No system is perfectly secure, and we will not claim otherwise. If we discover a
breach affecting your personal data we will notify you and the relevant
authority as the law requires.

## 13. Changes

If this policy changes materially we will update the date above and note the
change on the site. Continuing to use MyDNA after that means you accept the
revised policy.
