# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working across machines

This repo is developed from more than one machine via `origin`. Claude Code sessions are stored locally per machine and do not sync, so **this file is the handoff** — `git pull` first, and record anything a future session on the other machine would otherwise have to re-derive (in-flight work, decisions made and rejected, external state like Railway/Vercel/Stripe dashboard config) in the "Current state" section below.

## Current state

**Open, in priority order:**

1. **A mailing address that is not a home address** — the last blank, and now the *only* one. [legal/privacy-policy.md](legal/privacy-policy.md) still reads `[MAILING ADDRESS]`: this is a sole proprietorship, so its address is a residence, and a privacy policy publishes it permanently to an audience explicitly invited to read it. A CMRA suffices — Railway's own DPA address is a PMB — and a registered agent is only the better buy if an LLC follows within months, which it does not.

   **The earlier position was that both documents were unpublishable until this was set. That was overridden deliberately on 1 Aug 2026**, with the risk accepted: a CMRA is days away, and nobody knows the product exists yet. The pages are live at `/privacy` and `/terms` with a **draft banner that names the outstanding blank**, generated from the document text by `unresolved()` in [draft.js](frontend/src/draft.js) rather than from a flag — so it cannot be silenced by editing code, only by filling the address in. `draft.test.js` asserts the mailing address is the only thing left; when that test fails because the list is empty, the banner has done its job and can come off.

   `privacy@mydna.chat` is live (Namecheap forwarding to squirestudio@gmail.com, verified 1 Aug 2026), with SPF inherited from the forwarder and DMARC at `p=reject`. Domain contacts are under Squire Studio.
2. **An FAQ page**, agreed and deferred. Same pattern again. It is where the expectation-setting questions belong so `/about` stays a statement rather than a support document: "will this test my DNA?" (no — you bring your own file), "will it tell me if I'm sick?" (no), "is this a medical service?" (no), "is this a research database?" (no — MyDNA queries other people's data and holds none of its own).
3. **A Tennessee LLC** — recommended, not a blocker. There is no liability shield today; see the entity note in [legal/README.md](legal/README.md).

**MyDNA publishes under Squire Studio** — the lab where products ship, alongside Tik Attack Toe and SudoSwap. Red Wolf Agency is the client-work side and is expected to be MyDNA's marketing agency later. Both are the same legal person, so the choice carries no legal weight; it decides the name in archived pages and shared links, and it matches the accounts that already exist. Squire Studio is an *informal* trading name rather than a registered assumed name, so the documents name a person too — a controller must be identifiable as a legal person, and an unregistered trading name identifies nobody.

**The published name is "Ben Brown, trading as Squire Studio", and the footer names no person at all.** Nothing requires a middle name: the obligation is that the controller be identifiable, not that every given name appear. The full legal name stays in [legal/README.md](legal/README.md) where it is load-bearing — resolving who the trading names belong to, and recording who actually signed the Railway DPA — and nowhere on the site. Initials were considered and rejected; on a privacy policy an obscured identity works against the only job that line has.

It shortens twice more, and "How the name shortens" in `legal/README.md` is the full note. A **county assumed-name registration** lets the documents lead with Squire Studio; the **LLC** removes the personal name entirely, because an LLC is a legal person and the studio currently is not. The LLC is the real answer — the naming preference and the missing liability shield have one fix. **Re-paper Railway and Stripe in the same pass**: the Railway DPA is executed by the individual, and the Stripe account name reaches customers' bank statements, so a policy naming an entity neither knows about is a live inconsistency.

**[POSITIONING.md](POSITIONING.md) records the tagline, the positioning statement, the audience split and the pricing measurement** — including the candidates that were rejected and why, because those reasons keep applying. "Genetics Simplified" and the reading-level label "Precise" fail the same way: both imply the content is reduced when only the language is. "Fun", "Safe" and "Validated" were rejected as tonally wrong and as quasi-efficacy claims respectively.

**Legal drafts live in [legal/](legal/)** and are written from an audit of what the code actually does, not from a template. `legal/README.md` is the decision log — read it before changing anything in this area, because several product behaviours exist to satisfy specific clauses.

**`/privacy` and `/terms` render `legal/*.md` directly** — [legal.jsx](frontend/src/legal.jsx) imports the markdown with Vite's `?raw` and renders it through the shared `Markdown` component. There is deliberately no hand-converted JSX copy: a second original drifts from the one that gets reviewed, and the whole trust argument here is that the documents describe what the code really does. Editing the policy means editing the markdown. Two consequences: `vite.config.js` needs `server.fs.allow: ['..']` or `npm run dev` breaks while `npm run build` keeps working, and **a feature that processes a new category of personal data has to land in the policy in the same commit** — document upload did.

Both apps are deployed: backend on Railway, frontend on Vercel. Recent work has centered on the freemium gate — anonymous users are limited client-side (3 queries) before a sign-in prompt, authenticated users are limited server-side by `FREE_QUERY_LIMIT` (currently 20). Stripe checkout and webhook entitlement granting are wired up.

The most recent work audited NCBI coverage and closed the gaps: the app used 4 of the 39 E-utilities databases and no `elink`. It now also reads dbSNP, dbVar, GTR, MedGen and PMC, and matches an uploaded DNA file against the gene being discussed.

That audit then found **ten of the twenty sources silently returning nothing** — all now repaired; see "Upstream drift" below, which is the most important section in this file for anyone picking the project up. A BRCA1 query went from 6 populated datasets to 18.

`LollipopMap` is now interactive — scroll to zoom, drag to select a range, click to pin, filter chips, keyboard pan/zoom. Geometry and encodings live in [lollipop.js](frontend/src/lollipop.js) with 59 tests; the component is only SVG.

**ClinVar variants are sampled across significance bands on purpose.** `CLINVAR_BANDS` runs three searches — pathogenic/likely pathogenic (20), uncertain (10), benign/likely benign (10) — and merges them. Asking only for `clinsig_pathogenic[Properties]`, as this used to, returned a set that was 100% Pathogenic for *every* gene, so the map's colour channel carried no information: RYR1 drew 18 identical red circles. Dropping the filter fails the other way, since RYR1 unfiltered is 33/40 uncertain-significance. Results are sorted most-severe-first so the variant table still leads with what a reader came for. Changing the quotas changes both the map and the table.

**A privacy workstream landed alongside the source work, and parts of it are load-bearing** — see "Data protection" below. In short: signed-out visitors are no longer recorded at all, DNA upload now requires sign-in so consent can be evidenced, and export and erasure are self-serve. `/about` exists as a real URL, with routing in [root.jsx](frontend/src/root.jsx) above `App`.

`NCBI_API_KEY` **is set in Railway** but is not in the local `genomics_backend/.env`, so a dev container runs at 2.5 req/sec against production's 9.0. Worth adding locally before profiling anything or debugging a source that returns nothing — the symptom of the anonymous cap is an empty result, not an error.

Environment variables are set in the Railway and Vercel dashboards, not in the repo. The backend needs at minimum `ANTHROPIC_API_KEY` and `DATABASE_URL`; OAuth, Stripe, and stored-API-key features each stay disabled (returning 501) until their vars are set — see [config.py](genomics_backend/config.py) for the full list.

## Deployment topology

The public site is **https://mydna.chat** (apex A record → Vercel; `www` CNAME → Vercel). `genomechat.vercel.app` still resolves and is kept in the CORS allowlist so older links keep working. The API stays on `genomechat-production.up.railway.app` — users never see it, and moving it would mean changing `BACKEND_URL`, `VITE_API_URL`, the Google OAuth redirect URI, and both Stripe webhook endpoints together.

Adding a browser-facing domain means three coordinated changes, and missing any one fails quietly: the origin must be in `cors_origins` ([config.py](genomics_backend/config.py) — list apex *and* www, there is no wildcard), `FRONTEND_URL` must point at it (it builds the post-sign-in and post-checkout redirects, so a stale value silently moves users to the old domain mid-flow), and Vercel needs the domain plus DNS.

## Repository layout

Two independently deployed apps in one repo:

- `genomics_backend/` — FastAPI + SQLAlchemy + PostgreSQL. Deploys to Railway via `Dockerfile` (`railway.toml` sets healthcheck `/health`).
- `frontend/` — React 19 + Vite 8 + Tailwind 4. Deploys to Vercel via `frontend/vercel.json` (SPA rewrite to `index.html`).

`frontend/README.md` is untouched Vite boilerplate. The root `package.json` only carries stray Tailwind devDeps; the real frontend manifest is `frontend/package.json`.

## Commands

```bash
# Backend — full stack (postgres + api, hot-reloaded via bind mount)
cd genomics_backend && cp .env.example .env   # then set ANTHROPIC_API_KEY
docker compose up -d
docker compose up -d --build                  # REQUIRED after any requirements.txt change
docker compose --profile admin up -d          # adds pgAdmin on :5050

# Backend — bare uvicorn (needs a reachable DATABASE_URL, or it degrades gracefully)
cd genomics_backend && uvicorn main:app --reload --port 8000

# Backend — smoke-test the API end to end against a running server
cd genomics_backend && python examples.py

# Frontend
cd frontend && npm install
npm run dev        # Vite dev server
npm run build
npm run lint       # eslint (flat config, frontend/eslint.config.js)
```

**`restart` does not reload `.env`.** Compose reads `env_file` when it *creates* a container, so `docker compose restart` reuses the environment the container was born with. Editing `.env` and restarting looks like it worked and silently changes nothing — the same shape as the dependency trap below, and it is why a container kept reporting `LIVE MODE` after `.env` had been switched to test keys. Use `docker compose up -d` to recreate. The startup feature/Stripe lines are the tell: if they don't reflect your edit, the environment didn't reload.

**Two independent allowlists, deliberately not merged.** `UNLIMITED_EMAILS` bypasses the query quota entirely (for your own team); `STRIPE_TEST_EMAILS` switches checkout to Stripe test mode. They are separate because an account that never reaches the paywall can never exercise the purchase flow — merging them would make the billing path untestable. Put yourself on `UNLIMITED_EMAILS` for day-to-day work, and take yourself off when you want to test buying. Both default to empty, meaning nobody.

**Test-mode allowlist — how to exercise billing on production.** `STRIPE_TEST_EMAILS` is a comma-separated list of accounts that get *test-mode* Stripe checkout on the live deployment; everyone else gets live keys. It requires the parallel `STRIPE_TEST_SECRET_KEY` / `STRIPE_TEST_WEBHOOK_SECRET` / `STRIPE_TEST_PRICE_*` variables — an allowlisted email with test credentials missing falls back to live rather than producing a broken checkout. `/billing/webhook` verifies against the live secret and then the test secret, so both environments' events are accepted without weakening verification (a test event can never validate against the live secret). `/auth/me` returns `stripe_test_mode`, which drives a visible amber TEST badge so a 4242 purchase can't be mistaken for a real one. Grants from test purchases are real rows in the production database — that is the point, but it means the allowlist must stay short.

**Local development uses Stripe test keys; Railway uses live.** `scripts/setup_stripe_test.py` mirrors the live products into test mode and prints the `.env` lines (it refuses to run against an `sk_live_` key). `stripe listen --print-secret` supplies `STRIPE_WEBHOOK_SECRET`, and `stripe listen --forward-to localhost:8000/billing/webhook` forwards real events to the local container. Set `BACKEND_URL=http://localhost:8000` locally so the endpoint check knows not to expect a registered endpoint. `.env.live-backup` holds the live values — `cp .env.live-backup .env` switches back. Watch the boot line: `LIVE MODE` on a dev box means checkout charges a real card, and `TEST MODE` on Railway means production is quietly refusing real ones.

**Dependency drift is guarded, not merely documented.** `docker-compose.yml` bind-mounts `.:/app`, so source edits are live but installed packages are not — they live in the image. Two mechanisms close that gap:

- The Dockerfile writes the sha256 of the `requirements.txt` it installed from to `/opt/genomechat/requirements.sha256` — outside `/app`, so the bind mount cannot shadow it. [docker-entrypoint.sh](genomics_backend/docker-entrypoint.sh) compares it against the mounted file at boot and **refuses to start** on mismatch, printing the rebuild command. This replaces what used to be a `ModuleNotFoundError` traceback that read like a code bug.
- `develop.watch` in the compose file rebuilds automatically on `requirements.txt` changes under `docker compose watch`.

In production there is no bind mount, so the mounted and baked files are the same and the check is a no-op. If you add a dependency, rebuild — the container will tell you if you forget.

`genomics_backend/.dockerignore` excludes env files, `.git`, and bytecode from the build context — `.gitignore` has no effect on Docker builds, and the Dockerfile does `COPY . .`. Runtime is unaffected: compose passes secrets via `env_file`, Railway injects them from its dashboard, and pydantic-settings prefers real env vars over the `.env` file.

**Price follows measured cost, and one charge was removed for that reason.** A question costs about **$0.013** in model tokens (measured: 4,617 in + 1,639 out on Haiku 4.5). **A section fetch makes no model call at all** — public API traffic and a database read — so charging a credit for one bought the reader nothing, and it was the only line in the pricing that could not be defended on cost. Sections are now free, and `/gene/section` no longer checks quota either: refusing someone out of credits would be charging twice for a question they already paid for. A **scanned page costs `SCAN_CREDITS` (2)**, because Sonnet vision runs 2–3x a question. `CREDITS_PER_PACK` is 200, which also dilutes Stripe's flat 30c — on a $3 sale that fee is 10%. Full working in [POSITIONING.md](POSITIONING.md).

**Contributions grant nothing, and that is structural.** `create_support_session` is deliberately separate from `create_checkout_session`, and `purchase_type: "support"` is a value the webhook has no grant branch for. It is handled *before* the user lookup, because anyone can contribute signed out and a missing account there is normal rather than the paid-but-unmatched emergency that branch exists to shout about. Not called "Donate": a sole proprietorship is not a charity, so contributions are taxable income rather than deductible gifts, and the modal says both that and "unlocks nothing" on screen.

**Abuse limits are server-side.** `ANON_QUERY_LIMIT` (default 3) is enforced per client IP in [services/limits.py](genomics_backend/services/limits.py), not just counted in `localStorage` — the browser copy only decides when to show the sign-in prompt early. Per-IP rate limits apply to every route except `/health` (so a limited client cannot take the healthcheck down with it) and `/billing/webhook` (Stripe retries in bursts and is already authenticated by signature); expensive paths get a tighter ceiling than the rest.

Behind Railway's proxy `request.client.host` is the proxy, so `client_ip()` reads the left-most `X-Forwarded-For` entry. That is spoofable in general, which is why these are a fairness measure and a cost brake, never an authentication boundary. All of this state is per-process — see the note about scaling out under "Two independent allowlists".

**Frontend tests live beside the code they cover and run on every push.**

```bash
cd frontend && npm test          # 409 checks, ~0.6s
```

They cover pure logic, not component rendering: DNA parsing, SSE framing, plan
description, and which Explore-further items cost a credit. Component tests
against a 3,800-line file of inline styles would break on every visual tweak
while catching almost nothing, and that brittleness is how teams end up
abandoning frontend testing altogether.

The extraction order matters and is worth keeping: pull the logic out into a
module, write the test, then move the component. Doing it the other way is how a
refactor quietly breaks the DNA parser. `dna.js`, `sse.js`, `plan.js` and
`response.js` came out that way; the rest of App.jsx can follow feature by
feature.

**Query payloads expire.** `QUERY_PAYLOAD_RETENTION_DAYS` (default 90) drops the
stored result of old answers at startup, keeping the row. Set it well above the
age of your data unless storage is actually a problem — a user opening an old
chat and finding it empty is a worse trade than the kilobytes saved. History
handles a dropped payload by saying so and offering to ask again.

**Tests live in `genomics_backend/tests/` and run on every push.**

```bash
cd genomics_backend
python -m pytest -m "not external"   # 223 checks, ~1.5s, no network — what CI runs (195 + 2 skipped there; see below)
python -m pytest                     # all 297, adds the ones hitting real APIs
```

Anything reaching NCBI, Ensembl or Anthropic is marked `external` and excluded
by default: those tests are as flaky as the sources they call. Everything else —
access control, entitlements, subscription lifecycle, webhook idempotency,
allowlists, stored-key handling — is pure application logic and runs in CI
against a throwaway Postgres with placeholder credentials. The suite signs its
own Stripe events, so no real keys are needed.

`test_data/` holds sample 23andMe and AncestryDNA files for manually exercising the DNA upload path. `frontend/public/sample_23andme.txt` is the in-app downloadable sample.

`alembic` is in `requirements.txt` but unused — see "Schema migrations" below.

## Backend architecture

### The `/chat` request pipeline

`POST /chat/stream` in [main.py](genomics_backend/main.py) is the only chat endpoint — there is deliberately no second, non-streaming copy. One existed until it was removed: it duplicated the quota check, key resolution, pipeline dispatch, charging, persistence and caching, and the two drifted badly enough that the streaming path charged nobody for its entire life while the other worked. If you need a non-streaming response, collect the stream rather than adding a parallel handler.

It runs three stages:

1. **Interpret** — [services/query_interpreter.py](genomics_backend/services/query_interpreter.py) asks Claude to classify the message into `gene_query` / `disease_query` / `comparison_query` / `unknown`, using tool-calling (one tool per query type) rather than parsing free text. A regex `_fallback_interpret()` runs if the API key is missing or the call fails, so the endpoint never hard-fails on interpretation.
2. **Fetch** — [services/genomics_api_real.py](genomics_backend/services/genomics_api_real.py) runs the corresponding pipeline (`run_gene_pipeline` / `run_disease_pipeline`).
3. **Explain** — [services/ai_explainer.py](genomics_backend/services/ai_explainer.py) flattens the pipeline dict into a plain-text block and asks Claude to write the prose answer, with the last 4–12 turns of conversation history prepended.

`unknown` short-circuits stages 2–3 and goes straight to `answer_followup()`, which is how conversational follow-ups ("what does that mean?") work.

**The tool call is forced (`tool_choice: {"type": "any"}`), and there is a fourth tool for follow-ups. Both halves are load-bearing.** "Always call exactly one tool" was only ever a request in the prompt, and the model declined it for some inputs: *"what is hypotonia"* returned prose rather than a tool call **10 times out of 10**, and *"what is ataxia"* roughly 1 time in 10. A prose reply matched no branch, fell through to `_fallback_interpret()`, and became `unknown` — routing an answerable question (ClinVar has 20 genes for hypotonia; HPO lists 1,956) to the path that runs no pipeline. For ataxia the same bug was intermittent, so it read as an answer that occasionally arrived thin and worked on retry.

`interpret_followup_query` exists so that forcing a call is safe. Remove it and `tool_choice` will shove "what does that mean?" into a gene lookup, breaking every conversational turn in the app. It maps to `QueryType.UNKNOWN` deliberately, at **confidence 0.9** — the regex fallback returns **0.2**, and that number is the only thing separating "this is conversation" from "interpretation broke" in logs.

**A phenotype is a lookup, not a disease, and the tool description has to say so.** Hypotonia, ataxia, nystagmus and the rest are clinical *signs*; the model correctly declined to call a tool described as being for diseases. The description now claims signs and phenotypes explicitly and names the regression cases, and `_fallback_interpret`'s keyword list covers them too. `tests/test_query_routing.py` asserts all of this — including that phrasing never decides the route, since "hypotonia", "what is hypotonia" and "tell me about hypotonia" are one query. Note that no test could have caught the original bug from our side of the call: it lived entirely in the model's tool-calling behaviour, which is why the mocked tests assert on `tool_choice` being *sent*.

Two different models are used on purpose: interpretation is a cheap tool call, explanation is the long generation. Both model IDs are hardcoded in their respective service modules.

### The genomics fan-out

`run_gene_pipeline()` is the core of the backend. It queries **26 external biomedical APIs** (Ensembl, ClinVar, gnomAD, UniProt, AlphaFold, Reactome, GTEx, STRING, Open Targets, ClinPGx, NCI GDC/TCGA, ClinGen, GWAS Catalog, HPO, Monarch, dbSNP, dbVar, GTR, MedGen, PMC) in two `asyncio.gather` waves — the second wave depends on the UniProt accession and Ensembl ID resolved by the first.

**Set `NCBI_API_KEY`.** It is free and instant from an NCBI account, and it moves the E-utilities cap from 3 to 10 requests/sec — `_NCBI_RATE` in [genomics_api_real.py](genomics_backend/services/genomics_api_real.py) reads 9.0 with a key and 2.5 without. Seven of the sources are NCBI (ClinVar, dbSNP, dbVar, GTR, MedGen, PMC, PubMed), so without the key they queue behind one limiter and the ones at the back of the queue return nothing — which looks exactly like a gene having no data. That is how ClinVar silently reported zero variants for BRCA1. The boot log prints which mode is active; `ANONYMOUS` in production is a misconfiguration, not a default.

**Upstream drift is the dominant failure mode, and it is silent.** In July 2026 an audit found **ten of the twenty sources returning nothing** while reporting success — the defensive `except: return []` in every fetcher turns a moved endpoint into "this gene has no pathways". Nothing errored, nothing alerted, and the answers just got thinner. What had happened, and what to check first when a panel goes quiet:

| Source | Drift | Shape of the failure |
|---|---|---|
| ClinVar | `clinical_significance` split into germline/somatic/oncogenicity classifications | Old key still present but `{}` or `null` — an `isinstance(x, dict)` check took the legacy branch and every variant read "Unknown" |
| ClinGen | No JSON API; `search.clinicalgenome.org/kb` is a web app | 200 with 176 KB of HTML, fed to `.json()`. Use the CSV at `/kb/gene-validity/download`, cached |
| HPO | API retired | `hpo.jax.org/api/hpo` → 404 HTML. Now `ontology.jax.org/api` |
| PharmGKB | Became **ClinPGx** | `api.pharmgkb.org` no longer resolves *at all* — DNS failure, so it raised before any status code |
| Monarch | Keyed on HGNC, not NCBI Gene | `NCBIGene:672` → `total: 0` with HTTP 200. Resolve via its own `/search` |
| Open Targets | `knownDrugs` → `drugAndClinicalCandidates` | GraphQL rejects the *whole* query over one unknown field, then answers 200 with an `errors` array. **Always check `data["errors"]`** |
| GDC | `/ssms` has no `case.project.project_id` facet | 200, empty aggregation, and `warnings.facets` explaining why — a key nothing read. Use `/ssm_occurrences` |
| GWAS Catalog | No gene-keyed association endpoint | `associations/search/findByGene` 404s. Traverse gene → SNP → associations |
| GTEx | Needs a version-pinned GENCODE id | `ENSG00000012048.20`, not a symbol and not a bare Ensembl id. Resolve via `/reference/gene`; the suffix moves between releases |
| OMIM | `mimtype` gone | Kind is now the `oid` prefix symbol (`*` gene, `#` phenotype). Fixed, then **disconnected** for licensing — see below |

**A scheduled job now watches for this.** `.github/workflows/upstream-drift.yml` runs the `external` suite every Monday and opens an issue when a source stops answering. It exists because these tests were excluded from CI — correctly, they are as flaky as the network — which meant they only ran when somebody thought to run them, precisely the condition under which drift goes unnoticed for months. A failure is retried once before anything is reported, since a single NCBI hiccup is not drift and a weekly job that cries wolf gets muted. Repeat failures comment on one issue rather than opening a new one each week. **Set `NCBI_API_KEY` in repository secrets** — without it the job runs at 2.5 req/sec and its own concurrency produces timeouts that look like drift.

Three lessons worth generalising. **A 200 is not success** — check for an empty aggregation, an `errors` array, a `warnings` key, and a `content-type` that isn't JSON. **An empty result and a broken query are indistinguishable without a control**: `tests/test_upstream_contracts.py` asserts against answers that are not in reasonable doubt (BRCA1 is in the HR-repair pathways, CYP2C19 governs clopidogrel), because a test that merely asserts "returned a list" passes forever while the data is gone. And **an empty answer can be the right one** — BRCA1 genuinely has no drugs, because a tumour suppressor's loss of function is not a drug target; that is why the Open Targets test uses EGFR.

**Splitting an answer's prose is only safe when Explore further exists to catch the rest.** `AssistantMessage` renders Overview and Key Findings inline and leaves every other `##` section to the Explore-further menu — but that menu is gated on `msg.data`, and an answer that never ran the pipeline has none. Splitting one therefore did not defer the other sections, it **deleted** them: the backend streamed a complete reply and the reader saw its first line. `proseLayout()` in [response.js](frontend/src/response.js) now returns `mode: "whole"` whenever `msg.data` is absent, and everything data-less renders entire. This was the visible half of the hypotonia bug and it degraded *every* conversational follow-up, not just misrouted queries. If you ever gate Explore further on something else, revisit `proseLayout` in the same commit.

**An empty answer has to say it is empty.** `noResultsFor()` fires only for a disease query whose gene list is empty — deliberately never for a gene query, since a gene with no ClinVar variants still has pathways, expression and interactions, and claiming "no results" there would be false. Before it existed, a genuine miss and a routing failure rendered identically, so neither the reader nor we could tell them apart.

**Reading level is a separate axis from detail, and the default is plain.** `response_detail` is how much is said; `reading_level` is how hard the words are. They were conflated, and the base prompt asked for prose "accessible to a research scientist" — which is who it wrote for, so a reader looking up their own gene met "ablate" and "penetrance" unglossed. `READING_LEVEL_INSTRUCTIONS` in [ai_explainer.py](genomics_backend/services/ai_explainer.py) exposes **two** options — **Plain English** (default) and **Clinical** — and keeps `standard`/`technical` as accepted legacy keys, because a browser that has not reloaded still sends them and letting `technical` fall through would quietly downgrade a clinician's answer. `loadSettings()` migrates saved values. **"Precise" was considered as the opposite of "Plain" and rejected**: it would tell the reader plain mode is imprecise, which is the reverse of the commitment. A middle option was dropped because a control labelled "Standard" is where people land without choosing. Plain is the default, and the instruction is explicit that only the *language* simplifies — rounding a number or dropping a caveat to shorten a sentence would be simplifying the finding.

**The answer cache is keyed on the answer's shape, not just the question.** It keyed on the question alone, so the first reader's settings decided everyone's answer for 24 hours — asking for a technical explanation returned whatever plain reply happened to be cached, with nothing to indicate it. `response_detail` had that bug silently from the day the cache was added; `reading_level` would have inherited it. Any new field that changes what the model writes has to go into `cache_key` in the same commit.

**Four panels were rendering less than they were given, found by diffing the pipeline JSON against the frontend's property reads.** `disease_network.also_linked` is the one that mattered: consolidating `phenotypes` into that panel was justified on the grounds that nothing a reader is told exists would be lost, and `also_linked` — conditions with no phenotype annotations, which the diagram therefore cannot draw — was fetched and never shown, so the justification was true of the data and false of the page. Also restored: `disease_total`, ClinGen's `classified_on` (a Definitive call from 2015 and one from last year are different claims), and the GWAS `risk_frequency` (a strong association with something 2% of people carry reads nothing like one with something 60% carry). **That diff is worth re-running whenever a fetcher gains a field** — the frontend fails silently and identically whether a key is absent or misspelled.

**Ensembl VEP rides with `/dna/annotate` rather than being its own section.** dbSNP says where a variant is and what has been reported about it; VEP says what it is predicted to *do* — consequence type plus SIFT and PolyPhen. Both are triggered by the same explicit "look up what these mean" action, so pairing them adds no disclosure the reader has not already agreed to, and it means one wait instead of two. They run in a `gather` with `return_exceptions=True` so VEP being down cannot lose the dbSNP answer.

**The score travels with the label.** SIFT and PolyPhen disagree with each other regularly, and a "deleterious" at 0.04 is a much weaker claim than one at 0.00 — showing only the word overstates the weaker one. The panel labels the whole row "predicted:" for the same reason: these are algorithms' opinions, not findings, and the copy says so.

**GenCC is connected, and leads with disagreement.** `fetch_gencc_validity` groups assertions by disease and sorts by how far apart the curators are, not by how strong the consensus is — a split verdict is the more informative thing, because it tells a reader the science is unsettled and no single source will ever volunteer that. `consensus` is the *strongest* verdict on offer, never an average: averaging evidence grades would invent a classification nobody submitted.

**It arrives as a file, so [bulk_index.py](genomics_backend/services/bulk_index.py) exists.** A lazily-built, gene-keyed index with a lock so a cold process serving three requests starts one download rather than three, a five-minute cooldown after failure so an outage is not amplified, and the same degrade-to-empty contract as every fetcher. Orphanet's gene product would reuse it unchanged.

**Two numbers worth keeping.** The download is 26 MB but the resident cost is **7.7 MB RSS** — the export is thirty columns and five are kept, and the repeated ones (nineteen submitters, nine classifications across thirty thousand rows) are interned. Beware `tracemalloc` here: it reported 140 MB because it counts transient parse allocations the allocator has not returned to the OS. RSS is the number that matters and it is an order of magnitude smaller.

**It is warmed in the lifespan**, because building it costs ~28s and otherwise the first reader to open the panel on a cold process pays all of it and concludes the app is broken. `_warm_bulk_indexes` is fire-and-forget so a failure cannot stop the API starting. **Note the trap that cost a crash loop:** `lifespan` carries `@asynccontextmanager`, and inserting a new function directly above it moves the decorator onto the wrong function — `create_task` then receives a context manager and startup dies on every boot.

**The original measurement, kept because it justified the build.** I had called it incremental over ClinGen. That was an assumption, and it is wrong. Against our own `fetch_clingen_validity` on five genes:

| Gene | ClinGen diseases | GenCC diseases | New |
|---|---|---|---|
| COL1A1 | 3 | 12 | **+9** |
| SCN1A | 4 | 12 | **+8** |
| RYR1 | 2 | 10 | **+8** |
| BRCA1 | 2 | 6 | **+4** |
| F5 | 2 | 3 | +1 |

ClinGen is 3,653 of GenCC's 30,410 assertions — **12%**. The other 88% come from Labcorp/Invitae, PanelApp Australia, Orphanet, Ambry, G2P and eleven more.

**And the more interesting finding is disagreement.** Curators routinely reach different verdicts on the same gene–disease pair, and showing only ClinGen's hides that: COL1A1–Caffey disease is *Definitive vs Moderate vs Strong vs Supportive* across four submitters. Four or five disputed pairs per gene is typical. A panel that showed the spread would be saying something no single source can, and would be honest about how settled the science actually is. That is the reason to build it, more than the coverage.

Cost is a 26 MB TSV parsed into a gene-keyed index and held resident, which is why it wants one shared bulk-index mechanism rather than a bespoke loader — Orphanet would use the same.

**Orphanet is connected, and it exists to correct a misreading rather than to add a panel.** MyDNA had *no prevalence source at all* — grep confirmed it. gnomAD answers "how many people carry a variant in this gene", roughly 1 in 720 for some, drawn as a large dot grid; nothing on the page distinguished that from "how many people have the disease", which is often a thousand times rarer. A reader had every reason to conflate them. `PrevalencePanel` states the contrast in words at the top, quoting the carrier rate from the same answer, before showing any figure.

**Bands are Orphanet's published ranges, never midpoints.** "1-9 / 100 000" is a range they chose deliberately and averaging it would invent precision they withheld. Point prevalence and annual incidence are labelled separately for the same reason — they are routinely swapped and are not interchangeable. A band of `Unknown` is dropped rather than shown, because rendering an absence as a figure presents it as a finding.

**Three files, joined at query time**, all through `BulkIndex`: `en_product6` for gene → disorder, `en_product9_prev` for the bands, `en_product9_ages` for onset and inheritance. Parsed with `iterparse` and cleared per element — a DOM of a 36 MB XML is several times its size on disk, while clearing keeps the peak near one disorder. 85% of the 13,484 prevalence records carry a usable band.

**It covers rare disease only, and that is a feature to preserve.** A gene behind ordinary cardiovascular risk returns `[]` and the panel is absent rather than empty; claiming coverage it does not have would be worse than having none.

**Orphanet's REST API remains unusable for this, which is why it is bulk.** Verified reachable, and CC-BY 4.0 with commercial use permitted — the licence is declared inline in every API response. Their REST API exposes only `rd-cross-referencing`, so gene–disease associations are bulk-only (`en_product6.xml`, ~22 MB) and need a cached index rather than a call. Rare-disease gene links are already covered by HPO, Monarch and ClinGen, so this one genuinely is incremental. Categorised under "Licensed and available, not connected" in [legal/data-source-licensing.md](legal/data-source-licensing.md) — available when something wants it, blocked by nothing.

**Four sources were added after the original nineteen, and two of them are core on purpose.** `plain_summary` (MedlinePlus Genetics) and `constraint` (gnomAD) ride along in `run_gene_pipeline` rather than being offered as sections, because their job is to be **in the prompt**, not only on the page.

- **MedlinePlus Genetics** is the only source here written for patients rather than specialists — "the BRCA1 gene provides instructions for making a protein that acts as a tumor suppressor". It is given to the model as source material to build on, because a paraphrase is the model's words and this is a citable library's. Coverage is hand-written and partial, so a gene with no page returns `{}` and is not an error. One call, ~300 ms.
- **gnomAD constraint** reframes everything below it: "pathogenic" in a gene the population cannot afford to break is a different claim from the same word in one that tolerates loss freely. **LOEUF is displayed, not pLI** — pLI saturates at 1 for anything even moderately constrained while LOEUF stays continuous, which is gnomAD's own recommendation. The badge sits beside the gene's identity for that reason rather than in a panel below.
- **ClinicalTrials.gov** (`clinical_trials`) is the only section pointing at something a reader can act on, so it sorts by whether enrolment is open rather than by relevance. v2 API, no key. Watch the trap: v1's `study_fields` endpoints are retired.
- **PanelApp** (`panels`) answers a question none of the others do. ClinVar says a variant was observed and ClinGen says a gene–disease link is valid; PanelApp says the NHS *tests* this gene for that condition today. Amber and red entries are kept, because "reviewed and not adopted" is a real answer.

`tests/test_new_sources.py` asserts registration in CI and contracts against the live sources under `external` — SCN1A's LOEUF must land under 0.35, BRCA1 must appear on a green panel. Assertions that would merely pass forever while the data disappeared were avoided deliberately.

**Sending the reader to an external site is a last resort, not a default.** The pharmacogenomics panel was the worst case and is worth keeping as the example. Each row showed an evidence level and a drug name; everything that made the row *mean* something — which genotype, and what happens to someone carrying it — was behind a link to ClinPGx. Two things were wrong with that. The interpretations **were already being fetched and silently discarded**: the backend sent `phenotypes` (a list) and the panel read `ann.phenotype` (singular), so the field was always undefined and the trip out was never necessary. And ClinPGx is a single-page app that returns HTTP 200 and *then* renders an error for some accessions, so the trip out did not reliably work either — the same "a 200 is not success" lesson as the upstream-drift table, one layer up.

`fetch_pharmgkb_data` now returns `allele_phenotypes` (genotype → interpretation), `variant`, `rsids`, `types` and `has_guideline`, and the panel renders them inline. **When a DNA file is loaded, the row matching the reader's own genotype is marked** — `pgx.js`, matched in the browser like `variantsInLocus()`, sending nothing. That is the argument against link-outs in general: ClinPGx can show every genotype, and only MyDNA knows which one is yours.

`variant` is deliberately not called `rsid`: ClinPGx reuses one field for both rsIDs and star-allele lists (`SLCO1B1*1, *5, *15`), and only the rsID case can be matched against a genotyping array. `rsids` is extracted separately for exactly that reason, and star-allele annotations show without a match rather than guessing.

The remaining links are attribution rather than exits — AlphaFold and Reactome are interactive artefacts, PMC is full text — but any new panel should be built on the same question: is the reader being sent away for something we already have?

**A markdown table may have blank lines between its rows.** The model writes them both ways, and `parseTable` originally required the delimiter to be the very next line, so a real population-frequency table rendered as eight lines of raw pipes. It now skips blanks between the header, the delimiter and the rows, and stops at the first non-blank line without a pipe so following prose is not swallowed.

**The pictogram grid is chosen by spread, and the last dot is part-filled.** `sharedPictogramScale` used to pick the coarsest grid on which the *rarest group registered one dot* — a visibility test, in a panel that exists to compare. For a gene whose ancestry groups ran 1 in 720 to 1 in 1,000 it chose the thousand-grid, where all seven round to exactly one dot: seven identical pictures for seven different numbers, sitting directly above a bar chart that showed the differences fine. It now requires the spread between the most and least common group to cover at least `MIN_SPREAD_DOTS` (3), so the same case picks 10,000 and draws 13/13/12/10/10/10/10.

Requiring a minimum *count* instead was tried and is wrong the other way: 16 dots against 9 is perfectly legible on a hundred-grid, and forcing a finer one makes a common variant look rarer than it is. A pre-existing test caught that.

`fillOn()` returns `{whole, partial}` and the component draws the remainder as a genuinely part-filled circle — clipped, not faded, because opacity reads as "uncertain" rather than "part of one more person". That remainder is the only thing separating 1 in 950 from 1 in 960, which are both ten whole dots. It also removed a small lie: `filledOn`'s `Math.max(1, …)` drew a full dot for two tenths of one, overstating rarity in the panel meant to convey it. `filledOn` is kept for callers that want a count rather than a drawing.

**`popfreq` renders inline and is no longer offered in Explore further.** It is free, needs no fetch, and is the visualisation the model's Population Genetics prose reaches for with a table — a shared-scale dot grid compares ancestries in a way a column of `5.58e-04` cannot. The `SectionPanel` case and the `SECTION_GROUP` entry stay so stored answers that recorded it in `loadedOrder` still replay; only the offer is gone, or it would render twice.

**Suggested queries are buttons, and they have to be queries.** The explanation prompt writes them into an `## Explore next` section, parsed by `suggestedQueries()` in [response.js](frontend/src/response.js) and rendered as chips that send. The section it replaced was called "Suggested Follow-up Queries" and its prompt line — *"questions the researcher might want to ask"* — never said *ask whom*, so the model wrote questions **to the reader**: "Are you currently taking clopidogrel?", "Do you have a family history of early-onset cardiovascular disease?". Perfectly good prose, and completely unclickable — sending one to a genomics pipeline produces nothing. The old heading is still parsed so stored answers keep working, and `isRunnableQuery()` filters second-person lines out of them. Context that genuinely depends on the reader now has its own home in `## Worth knowing`, which stays prose.

**`EXPLAIN_MAX_TOKENS` was 1200 and gene answers were being cut mid-sentence.** Because `Explore next` is the last section written, the suggestions were usually the casualty — richest answers, no follow-ups, and no error anywhere. Now 2000; the conversational path always had 2500, so this was the outlier. `fallbackQueries()` builds suggestions from the pipeline data when the model wrote none, so a truncated answer still offers somewhere to go.

**Gene symbols in prose are clickable, and bold is not how they are found.** The prompt asks for bold on "gene names, population names, and key clinical terms", so bold would offer **Pathogenic** and **East Asian** as queries. [genes.js](frontend/src/genes.js) uses two tiers: symbols present in the answer's own pipeline data (certain), then shape plus a stoplist plus a digit-or-four-characters rule. That rule is what keeps `OI`, `MS`, `CF` and `AF` out — the same disease-abbreviation trap `services/safety.py` hit from the other side. `ATM` is a real gene that the shape tier declines and the data tier accepts, which is the right answer in both directions.

**Clicking a gene prefills the input; clicking a chip sends.** Deliberate asymmetry. Inline words are the easiest thing on the page to hit by accident, especially selecting text on a phone, and a query costs a credit with no undo — so prefill keeps the momentum without the misclick, and lets `COL1A1` become `COL1A1 pathogenic variants` before spending. A chip under a heading is a deliberate act, so it sends, and the row states the cost the way Explore further already does.

**Explore Further is grouped, not a flat list.** `EXPLORE_GROUPS` and `SECTION_GROUP` in [response.js](frontend/src/response.js) sort cards by the question a reader is asking — clinical consequence, then mechanism, then treatment, then evidence — rather than by which institution answers it. Nineteen ungrouped cards was a wall in which the good ones got lost. A section missing from `SECTION_GROUP` falls to "evidence" rather than disappearing, and a test asserts every renderable key has a group.

**`phenotypes` was consolidated into `disease_network`.** Both drew on the same HPO data, so offering both charged twice for one body of evidence; the network presents it organised by disease and adds the related-genes edge. `fetch_hpo_terms` and `fetch_monarch_associations` remain and are tested, and `PhenotypePanel` is left in the frontend so stored answers replay. `disease_network` carries `also_linked` so consolidating did not narrow what a reader is told exists.

**OMIM is fetched-but-not-offered.** `DISCONNECTED_SECTIONS` in [genomics_api_real.py](genomics_backend/services/genomics_api_real.py) records why: OMIM is free for academic use and **commercial use requires a Johns Hopkins licence**, which a paid subscription plausibly needs. It is withheld from `OPTIONAL_SECTIONS` *and* from the `simple` dispatch map, so `/gene/section` cannot reach it by being asked directly. `fetch_omim_data` and its tests are intact — a licence makes it a two-line restoration. The frontend panel is deliberately left in place so stored answers containing OMIM data still replay. Cost of removal was measured first, not assumed; see [legal/data-source-licensing.md](legal/data-source-licensing.md), which covers the terms for every source.

**Adding an NCBI source: use `elink`, not a text search.** `elink_ids(dbfrom, db, uid, client)` traverses from a Gene UID to the curated links in another database — 18,354 ClinVar records, 22,227 dbSNP entries, 447 GTR tests for BRCA1. A search for `"BRCA1"` matches records that merely mention it; the link is the asserted relationship. **An elink call that omits `db` returns PubMed links only**, which reads as a working call that happened to find nothing elsewhere.

**Genome build is load-bearing, not a detail.** 23andMe and AncestryDNA report GRCh37; Ensembl's main REST endpoint serves GRCh38. BRCA1 sits at chr17:41,196,312 on one and chr17:43,044,292 on the other — 1.85 Mb apart, a different part of the chromosome entirely. `fetch_gene_locus_grch37()` exists as a separate function from `lookup_gene_ensembl()` so the two builds cannot be confused at a call site, and `variantsInLocus()` in the frontend refuses a locus whose `assembly` is not GRCh37 rather than silently intersecting against it.

**A new section must be registered in five places**, and each omission fails quietly and differently: `OPTIONAL_SECTIONS` (offered at all), `SECTION_SOURCE` (attribution), `DICT_SECTIONS` (whether an empty result is `{}` or `[]`), the `simple` dispatch map in `fetch_gene_section`, and — in the frontend — both `EXPLORE_LABELS` and `ALL_SECTION_KEYS` in [response.js](frontend/src/response.js). `test_ncbi_sources.py` and `response.test.js` assert the registries agree.

Every gather uses `return_exceptions=True` and every result passes through `safe()`/`safe2()` before landing in the returned dict. **This is the central design invariant: any upstream source may be down, rate-limited, or return a changed schema, and the response must still be well-formed.** The `sources` list at the bottom of the returned dict is built by checking which fetches actually produced data, so it reflects reality per-request. When adding a new source, follow the same shape — a `fetch_*` coroutine that swallows its own errors and returns `[]`/`{}`, added to the gather, with a key in the result dict and an entry in `sources`.

These upstream APIs are undocumented-in-practice and inconsistent; much of the parsing code defensively handles multiple response shapes for the same field (see the clinical-significance extraction in `fetch_clinvar_variants`, which checks three different locations). Preserve that defensiveness when editing.

### Caching and persistence

An in-process `LRUCache` ([services/cache.py](genomics_backend/services/cache.py), MD5 of the normalized query, 24h TTL) sits in front of the whole pipeline. It is per-process and dies on redeploy — there is no Redis.

The full response (prose + data + sources) is stored in `queries.results` as JSON so chat history can be replayed without re-running the pipeline. DB writes are wrapped in try/except and only logged on failure — **the app is designed to keep serving chat when Postgres is unavailable**, including `create_tables()` at startup.

### Auth, billing, and the query gate

Google OAuth → JWT, in [auth.py](genomics_backend/auth.py). The JWT goes back to the frontend via a redirect query param and lives in `localStorage`.

`get_current_user` returns `Optional[User]` and **never raises** — anonymous use is a first-class path. Use `require_user` only on routes that genuinely need identity (billing, API-key storage). This distinction is load-bearing for the freemium flow.

Two separate limits, enforced in different places:

- **Anonymous**: `ANON_QUERY_LIMIT = 3`, counted client-side in `localStorage` (`App.jsx`). Advisory only — it gates the sign-in modal, not the API.
- **Authenticated**: `FREE_QUERY_LIMIT` in [services/billing.py](genomics_backend/services/billing.py), enforced server-side. `user_can_query()` returns 402 with an `upgrade_required` payload the frontend turns into the upgrade modal.

### Access control

Ownership is always derived from the JWT and **never** from client-supplied input. `database/routes.py` provides two helpers that every project/query route goes through:

- `_owned_by(model, current_user)` — a filter applied inside the lookup, so a non-owner gets "not found" rather than a row it can then be checked against.
- `_require_owner(row, current_user)` — for routes that must fetch by id first.

Anonymous callers own the `user_id IS NULL` rows, which is what the anonymous `/chat` path creates. Both helpers return **404 rather than 403** on a non-owner, so sequential integer ids cannot be enumerated.

Two patterns to avoid, both of which were live bugs:

- Taking `user_id` as a query parameter or request-body field. It is attacker-controlled; read it from `current_user`.
- Writing the ownership test as a post-lookup `if current_user and row.user_id and ...`. An unauthenticated caller makes that whole condition falsy and skips the check. Put the test in the query.

`GET /share/{token}` is intentionally public — that is the point of a share link — but `POST /queries/{id}/share` is owner-only, so tokens can only be minted for rows you own.

`JWT_SECRET` has no fixed default. If unset, [config.py](genomics_backend/config.py) generates a random per-process secret and logs a warning: sessions then break on restart, which is the correct failure mode versus shipping a publicly known signing key. Set it in any real deployment. Likewise `cors_origins` must not contain `"*"` — the middleware runs with `allow_credentials=True`, and Starlette echoes the request origin in that combination.

Anthropic API key resolution order in `/chat`: request body → user's server-stored encrypted key → shared server key. Stored user keys are Fernet-encrypted ([services/encryption.py](genomics_backend/services/encryption.py)) with `ENCRYPTION_KEY` and are never returned to the frontend — `/auth/me` exposes only a `has_stored_key` boolean.

**A stored key only counts as BYOK if it actually decrypts.** `user_can_query()` and `consume_query()` take an explicit `has_working_key`, resolved once in `/chat` before the quota check, and `/auth/me` reports usability rather than mere presence. Never reintroduce a presence-only test like `if user.encrypted_api_key` — that was a live billing hole: a non-null but undecryptable key (rotated `ENCRYPTION_KEY`, corrupted ciphertext) granted unlimited queries while the request silently fell back to the *shared server key*, so the operator paid for them. `try_decrypt_key()` returns `None` on any failure and logs at ERROR; callers must treat `None` as "no key", never as "proceed on the shared key with BYOK privileges".

Stripe: `/billing/checkout` creates a session carrying `user_id` + `purchase_type` in metadata; `/billing/webhook` reads that metadata back to grant either `byok_unlocked` (one-time unlimited) or `query_credits`. The webhook is the only place entitlements are granted.

**The webhook must be idempotent.** Stripe delivers at-least-once — it retries failures for up to 3 days and events can be resent by hand. The grants are additive, so each event id is claimed in `processed_stripe_events` *before* anything is applied; a replay hits the primary key and returns `200 {"duplicate": true}` so Stripe stops retrying. Never apply an entitlement without claiming the id first.

**Webhook endpoints are per-account and per-URL, and a mismatch is silent.** A destination registered in a different Stripe account than `STRIPE_SECRET_KEY` belongs to — or at the right host but the wrong path — produces no error anywhere: checkout opens, the customer pays, the charge lands, and no event is ever delivered. Both happened in practice. `_validate_stripe_wiring()` runs at boot and checks that the key's account contains both price IDs and an enabled endpoint at `BACKEND_URL + /billing/webhook` subscribed to `checkout.session.completed`. Watch for `Stripe webhook endpoint verified:` in the deploy log; an ERROR there means payments will succeed while entitlements silently never land.

Two related traps: price IDs are also per-account and per-mode, so a live key with test-mode prices fails at checkout; and `FRONTEND_URL` builds the post-payment redirect, so if it points at localhost in production the webhook still works but the customer lands nowhere.

**Never report a purchase as successful from the redirect alone.** `?payment=success` only means Stripe redirected — the frontend polls `/auth/me` until the entitlement actually appears, and says so plainly if it never does.

Optional features (OAuth, Stripe, stored API keys, the shared Claude key) degrade to 501s when unconfigured. `_log_feature_status()` runs in the lifespan and logs each one as enabled or DISABLED at boot, so a misconfigured deploy is visible in the deploy log rather than discovered by a user hitting a dead button. Add new optional config to that list.

### Data protection — behaviours that exist for a legal reason

These look like ordinary product decisions and are not. Each satisfies a
specific obligation, and reverting one for convenience would quietly break a
published commitment. [legal/README.md](legal/README.md) has the full reasoning.

**Signed-out visitors are never recorded.** `/chat/stream` skips the DB write
entirely when there is no user — the guard is explicit, not incidental. Their
questions used to be stored as `user_id IS NULL` rows, which meant holding a
record of what someone asked before they had agreed to anything, and a question
can identify its asker. The privacy policy now states outright that nothing is
stored for them. Do not reintroduce anonymous persistence for analytics.

**DNA upload requires sign-in.** `requestDnaUpload()` in App.jsx gates all three
entry points. Not a paywall — DNA stays inside the free allowance — but genetic
data is Article 9 special category, processed on explicit consent, and consent
must be recorded against *someone*. It also closes section 11.1 of Railway's
DPA, which puts the consent record on us. The modal copy says exactly this,
because a sign-in wall in front of someone's own data otherwise reads as a
money grab.

**Consent is a bare timestamp.** `users.dna_consent_at`, written by
`POST /user/dna-consent`. No variants, no file, no record of what was then
looked at — Article 7(1) requires demonstrating consent, and a timestamp is the
least that meets it. Recorded best-effort from the client: a failed write must
not stand between someone and their own data when consent was given regardless.

**Export and erasure are self-serve**, in Settings → Your Data.
`GET /user/export` returns the account as portable JSON and **deliberately
excludes the stored API key** — it is the reader's credential, and an export
must never become a route for reading secrets back out. `DELETE /user/account`
erases the account, its queries and its projects; queries without a project do
not cascade, so they are deleted explicitly. It reports
`subscription_needs_cancelling`, because removing our record of a subscription
does not stop Stripe billing for it. Twelve tests in
`tests/test_privacy_rights.py` cover this, including that erasing one account
touches no other.

**MyDNA is not offered in the EEA or UK**, which is why no Article 27
representative is appointed. Stated in the Terms rather than left implied. The
data rights are honoured for everyone regardless of location anyway, since
export and erasure already exist and extending them costs nothing. Revisit if
pricing, languages or marketing ever target those regions.

**Uploaded documents are never stored, and three separate obligations depend on
that.** `personal_documents` on `ChatRequest` carries the reader's own papers
into the prompt for one request and is never written anywhere — same rule as
`personal_variants`, and `tests/test_document_privacy.py` asserts it by
inspecting the `stored` payload and every `QueryModel(...)` construction, since
this is the kind of thing that gets added "just for history" by someone who does
not know why it is absent. The three reasons fail differently and all three
matter: **privacy**, because a paper about someone's own condition discloses a
suspected diagnosis and is arguably more revealing than their variants — a
genome needs interpretation, "I am reading about osteogenesis imperfecta" does
not; **copyright**, because MyDNA has no licence to hold a publisher's text, and
needs none to help someone read their own lawful copy; and **honesty**, because
the upload notice promises outright that nothing is stored.

Document upload sits behind the same sign-in gate as DNA, for the same Article 9
reason, and `SignInGateModal` has a `documents` branch that says so — a wall in
front of someone's own research otherwise reads as a money grab.

The clean path to ever sharing anything from an upload is **the pointer, not the
document**: `extractCitation()` in [documents.js](frontend/src/documents.js)
pulls the DOI and PMID, which are facts rather than the publisher's expression
and point at records the existing PubMed and PMC fetchers may already retrieve.
Nothing does that yet. Do not add a shared corpus of uploaded text.

### Not a diagnostic tool — how that is actually enforced

[services/safety.py](genomics_backend/services/safety.py) holds two independent
guards, and both exist because a single one that misses ships a diagnosis. This
became urgent with document upload: a reader holding their own genome *and* a
paper about their own condition is one sentence from "so do I have it?", and a
model handed both will answer unless told not to.

- **input** — `detect_diagnostic_intent()` reads the question before generation
  and injects a reframing directive. It is tuned to leave factual questions
  alone, and that distinction is the whole difficulty: "do I have the rs334
  variant" asks what is in the reader's own file and has a true answer, while
  "do I have sickle cell" asks for a diagnosis. Matching bare uppercase tokens
  as gene symbols was tried and is wrong — "do I have **OI**" escapes the guard
  that way, and **DMD** is both a gene and Duchenne muscular dystrophy — so the
  factual test requires the word *variant*, *allele*, *mutation* or an rsID.
- **output** — `NO_DIAGNOSIS_RULES` is concatenated into `SYSTEM_PROMPT` at
  import time rather than passed by callers who might forget, so it is present
  on every path whether or not the input guard fired.

**The reframe redirects, it does not refuse.** The gene–phenotype relationship
the reader is circling is a real fact they are entitled to, so a diagnostic
question is answered by restating what the data shows — what is associated with
what, in whose cohort, at what strength — and then naming the limit. Refusing
outright would be unhelpful and faintly dishonest. `tests/test_no_diagnosis.py`
tests both directions, because over-flagging teaches people to ignore
disclaimers just as surely as under-flagging ships one.

### Schema migrations

`create_tables()` in [database/models.py](genomics_backend/database/models.py) calls a hand-rolled `_run_migrations()` — a list of idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements, each individually try/excepted. Adding a nullable column to an existing table means appending one line there, not writing an Alembic revision. This runs on every boot.

`Settings.get_database_url()` rewrites Railway's `postgres://` to the `postgresql://` SQLAlchemy requires.

### Config

All config is [config.py](genomics_backend/config.py) `Settings` (pydantic-settings, reads `.env`, `@lru_cache`d). Add new settings there rather than reading `os.environ` directly. Note `backend_url` exists specifically because Railway's proxy strips https from `request.base_url`, which breaks the OAuth callback URL — leave that override path intact.

## Frontend architecture

[frontend/src/App.jsx](frontend/src/App.jsx) is a single ~3,300-line file containing ~40 components and the entire app. There is no router, no state library, no component directory. Tailwind utility classes inline; `App.css`/`index.css` hold only a small amount of global styling.

The structure that makes it navigable: **each key in the backend's pipeline dict has a matching display component** — `pathways` → `PathwayViewer`, `expression` → `ExpressionChart`, `interactions` → `InteractionNetwork`, `drugs` → `DrugPanel`, `gwas` → `GWASPanel`, `hpo`/`monarch` → `PhenotypePanel`, `pharmgkb` → `PharmGKBPanel`, `cancer_mutations` → `CancerMutationsPanel`, `clingen` → `ClinGenPanel`, `omim` → `OmimPanel`, `population_summary` → `PopulationFrequencyChart`, `publication_timeline` → `PublicationTimeline`, `variants` + `domains` → `LollipopMap`, `structural_variants` → `StructuralVariantsPanel`, `genetic_tests` → `GeneticTestsPanel`, `medgen` → `MedGenPanel`, `full_text` → `FullTextPanel`, `gene_locus_grch37` + uploaded DNA → `MyVariantsPanel`. `SectionPanel` dispatches by key; `DataSection` handles the variant table. Adding a backend data source means adding a `fetch_*` in the pipeline and one panel component here — and registering the key in the five places listed under "the genomics fan-out".

Charts and the lollipop variant map are hand-rolled SVG — no charting library.

**Routing is one `if` in [root.jsx](frontend/src/root.jsx), above `App`.** Not a
router, and deliberately not inside `App` — that component has a great many
hooks, and a second view behind an early return there would be one reordering
away from breaking the rules of hooks. Vercel rewrites every path to
`index.html`, so `/about` is a real, linkable, crawlable URL. `/privacy`,
`/terms` and an FAQ follow the same three-line pattern.

**Centred empty states use `justify-content: safe center`.** Plain centring
overflows equally in both directions and a scroll container cannot scroll above
its own start, so with the DNA banner taking a strip of height the top of the
logo became unreachable. The plain declaration is kept ahead of it as a
fallback, and the inline `justifyContent` had to be removed because it would
have beaten the rule.

### Colour tokens — measure, do not eyeball

Every text colour is a token in [index.css](frontend/src/index.css), defined twice: `:root[data-theme="light"]` and `:root[data-theme="dark"]`. **Compute the contrast ratio before changing one**, against the *card* background (`#1e293b` dark, `#ffffff`/`#f1f5f9` light) rather than the page — cards are the harder ground and most text sits on them. Body text wants 4.5:1; genuinely incidental labels can sit at 3:1.

Two failures found this way, both invisible to inspection because the values *look* plausible in a palette:

- **A token shared verbatim between themes.** `--text-faintest` was `#1e293b` in dark — the exact card colour, **1.00:1**. `--violet-soft` is still `#7c3aed` in both, which is 2.39:1 on a violet-tinted badge in dark. A value that appears identically in both blocks is the tell: it was almost certainly only ever checked against one of them.
- **A border colour used as a text colour.** `--border-solid` was doing this in nine places, at 1.00:1 dark and 1.18:1 light, so disabled buttons had no readable label. Disabled controls are exempt from contrast minimums, which is not the same as being allowed to vanish. `--text-disabled` now exists for that role; keep `--border-solid` for borders.

`--text-faintest` and `--text-dimmer` are the two most-used text colours in the app (76 and 70 uses), so a mistake in either is felt everywhere.

**PDF export is forced light, and that is deliberate.** A report is a printed artefact, so it should not follow the screen theme. Three separate things carried the theme into it, and all three had to be handled — a wrapper that only fixed one would still have produced a mostly-dark report:

1. `var()` colours in the report HTML resolved against the root. The wrapper now carries `data-theme="light"`, which works because the token block's third selector (`[data-theme="light"]`, no `:root`) lets any subtree opt in and custom properties inherit.
2. `html2canvas`'s `backgroundColor` was read with `cssVar()`, which resolves against `documentElement`. Use `cssVarFrom(wrapper, …)` for anything inside a subtree on a different palette.
3. **3Dmol holds its own WebGL clear colour, which CSS cannot reach at all.** A viewer running dark bakes a dark background into the PNG regardless of the surrounding document. Each viewer is repainted white for the capture and restored afterwards.

The hardcoded badge colours in the report HTML were always light-appropriate (dark text on light tints), so they needed no change — it was only the tokens that flipped. Any new theme-scoped rule that needs to reach the report must be written without `:root`, as `.prose-genomics code` now is.

`API` is `import.meta.env.VITE_API_URL || "http://localhost:8000"`; set `VITE_API_URL` in Vercel.

### Personal DNA data — the privacy invariant

`parseDNAFile()` parses 23andMe, AncestryDNA, and VCF **entirely client-side**. Parsed variants live in React state and `sessionStorage` only, and are sent to `/chat` in the `personal_variants` field per-request. The backend passes them into the prompt and **never writes them to the database** — `main.py` stores `pipeline_result`, not `request.personal_variants`.

This is the product's core privacy claim, stated in the UI consent modal and in comments across both codebases. Do not add persistence, logging, or DB storage of `personal_variants` anywhere in the request path. `/dna/annotate` is held to the same rule — it forwards rsIDs to dbSNP and returns them, and deliberately keeps them out of its own error log.

**Which variants get sent is a correctness question, not just a privacy one.** `selectRelevantVariants()` in [dna.js](frontend/src/dna.js) picks them by evidence of relevance: named in the question, then inside the gene being asked about, then the curated `NOTABLE_VARIANTS` panel, then whatever fills the 200-variant budget. It replaced `.slice(0, 200)`, which took the first 200 *in file order* — and these files are sorted by chromosome and position, so that was always the start of chromosome 1 and therefore almost never related to the question. The model was being handed a slice of someone's genome chosen by file order and asked to comment on their BRCA1.

**Matching happens in the browser.** `variantsInLocus()` intersects the reader's variants against the gene's GRCh37 coordinates locally, so working out which of their variants are relevant sends nothing anywhere. Only the explicit "look up what these mean" action discloses rsIDs, and the panel says so before it is clicked.

`computeDnaSummary()` lives in `dna.js` beside `NOTABLE_VARIANTS` rather than in `App.jsx`. It used to be in the component while the constant had moved, unexported, into the module — so it threw a `ReferenceError` for every reader with DNA loaded, and nothing in the app surfaced it. Keep logic next to the data it reads, and note that `npm run lint` catches exactly this class of break while the test suite does not.

### Uploaded documents — two paths, and which one decides both privacy and price

[extract.js](frontend/src/extract.js) routes a file by `classifyFile()`, and that one function decides whether the reader's page ever leaves their machine and whether it costs anything:

| Input | Path | Leaves the browser? | Cost |
|---|---|---|---|
| PDF with a text layer | `pdf.js`, in-browser | No | Free |
| Photo, scan, HEIC | `POST /documents/extract` → Claude vision | Yes, to Anthropic only | One credit per page |

**The upload copy is a commitment, so the two notes differ on purpose** — the PDF note says "nothing leaves your device" and the image note does not, because for images it would be false. `extract.test.js` asserts that difference; it is the kind of wording that gets "tidied" into consistency by someone who has not read this.

**HEIC needs its own decoder and its own detection.** iPhone photos are HEIC, no browser paints one to a canvas, and Chrome and Firefox commonly report an empty MIME type for them — so the extension is the reliable signal, and `classifyFile` checks it. Without this the most natural way to capture a page silently fails. `heic-to` is ~751KB gzipped and `pdfjs-dist` ~127KB; both are behind dynamic `import()` and build to their own chunks, so a reader who never uploads downloads neither. Verify that after any Vite or dependency change: losing the code-split would put 751KB in the critical path for everybody.

**CI runs with no `ANTHROPIC_API_KEY`, and tests have to be written for that.** It has bitten twice. `interpret_query` returns its regex fallback when no key is set, so mocked classifier tests never reach the mock unless they patch `get_settings` too. `/documents/extract` reports 501 *before* the quota check, so its 402 tests are unreachable there — they are `skipif`-ed on the key, and a mirror test asserts the 501 when it is absent, so each branch is covered where it is actually reachable. **Simulating this locally means a keyless *server*, not just keyless pytest** — the first attempt set the variable only in the test process while the container's uvicorn still held a key, which reproduced nothing. Run a second uvicorn with `ANTHROPIC_API_KEY=""` on another port and point `MYDNA_TEST_BASE_URL` at it — then **`docker compose restart backend` before trusting the suite again**, because two servers sharing one Postgres leaves the state that the DB-backed tests trip over. Skipping that step produced 25 failures that looked like a broken feature and were nothing of the kind.

**A test that costs money must say so.** `tests/test_document_extract.py` keeps the vision call behind the `external` marker and asserts the gate, the bounds and the charge without it. The subtle one is `test_the_ceiling_itself_is_allowed`: it runs on an account with no quota left, because pydantic validates the body before the handler runs, so a 402 proves the schema accepted eight pages. Written the obvious way — a funded account — that single CI test made a real eight-page vision call on every push. Verified by counting Anthropic requests in the container log across a run: the CI subset makes zero.

**Client-side OCR was considered and rejected.** On the material that matters — a phone photo of a rotated two-column genetics paper — it produces confident garbage, and a wrong character in `c.507G>A` silently makes it a different variant. No transcription beats a plausible wrong one, because nothing downstream can tell. That is also why `VISION_MODEL` is Sonnet rather than the Haiku used everywhere else.

**Passages are selected, not sent whole.** `selectPassages()` in [documents.js](frontend/src/documents.js) is the document analogue of `selectRelevantVariants()` and exists for the same reason: a paper is far too long to send every turn. It scores by term overlap with the question and the gene under discussion, weights gene symbols and rsIDs far above ordinary words, restores reading order within each document before sending, and falls back to opening passages when nothing matches — an abstract is where a paper says what it is, and sending nothing makes the upload look broken.

### External runtime dependencies

`load3Dmol()` injects the 3Dmol.js viewer from a CDN at runtime rather than bundling it; `viewerRegistry` (a module-level `Map`) exists so PDF export can pull a WebGL snapshot out of a live viewer. Protein structures are fetched from AlphaFold's public API by URL.
