# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working across machines

This repo is developed from more than one machine via `origin`. Claude Code sessions are stored locally per machine and do not sync, so **this file is the handoff** — `git pull` first, and record anything a future session on the other machine would otherwise have to re-derive (in-flight work, decisions made and rejected, external state like Railway/Vercel/Stripe dashboard config) in the "Current state" section below.

## Current state

**Open, in priority order:**

1. **A mailing address that is not a home address** — the last blank. [legal/privacy-policy.md](legal/privacy-policy.md) reads `[MAILING ADDRESS]` on purpose: this is a sole proprietorship, so its address is a residence, and a privacy policy publishes it permanently to an audience explicitly invited to read it. **Both legal documents are unpublishable until it is set.** A CMRA suffices — Railway's own DPA address is a PMB — and a registered agent is only the better buy if an LLC follows within months, which it does not.

   `privacy@mydna.chat` is live (Namecheap forwarding to squirestudio@gmail.com, verified 1 Aug 2026), with SPF inherited from the forwarder and DMARC at `p=reject`. Domain contacts are under Squire Studio.
2. **Wire `/privacy` and `/terms`** as real routes once (1) is done — same pattern as `/about` in [root.jsx](frontend/src/root.jsx) — plus footer links beside "About MyDNA".
3. **An FAQ page**, agreed and deferred. Same pattern again. It is where the expectation-setting questions belong so `/about` stays a statement rather than a support document: "will this test my DNA?" (no — you bring your own file), "will it tell me if I'm sick?" (no), "is this a medical service?" (no), "is this a research database?" (no — MyDNA queries other people's data and holds none of its own).
4. **A Tennessee LLC** — recommended, not a blocker. There is no liability shield today; see the entity note in [legal/README.md](legal/README.md).

**MyDNA publishes under Squire Studio** — the lab where products ship, alongside Tik Attack Toe and SudoSwap. Red Wolf Agency is the client-work side and is expected to be MyDNA's marketing agency later. Both are the same legal person (Benjamin Kenneth Brown), so the choice carries no legal weight; it decides the name in archived pages and shared links, and it matches the accounts that already exist. Squire Studio is an *informal* trading name rather than a registered assumed name, which is why the documents read "Benjamin Kenneth Brown, trading as Squire Studio" — a controller must be identifiable as a legal person.

**Legal drafts live in [legal/](legal/)** and are written from an audit of what the code actually does, not from a template. `legal/README.md` is the decision log — read it before changing anything in this area, because several product behaviours exist to satisfy specific clauses.

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

**Abuse limits are server-side.** `ANON_QUERY_LIMIT` (default 3) is enforced per client IP in [services/limits.py](genomics_backend/services/limits.py), not just counted in `localStorage` — the browser copy only decides when to show the sign-in prompt early. Per-IP rate limits apply to every route except `/health` (so a limited client cannot take the healthcheck down with it) and `/billing/webhook` (Stripe retries in bursts and is already authenticated by signature); expensive paths get a tighter ceiling than the rest.

Behind Railway's proxy `request.client.host` is the proxy, so `client_ip()` reads the left-most `X-Forwarded-For` entry. That is spoofable in general, which is why these are a fairness measure and a cost brake, never an authentication boundary. All of this state is per-process — see the note about scaling out under "Two independent allowlists".

**Frontend tests live beside the code they cover and run on every push.**

```bash
cd frontend && npm test          # 48 checks, ~0.3s
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
python -m pytest -m "not external"   # 73 checks, ~1s, no network — what CI runs
python -m pytest                     # all 80, adds the ones hitting real APIs
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

Two different models are used on purpose: interpretation is a cheap tool call, explanation is the long generation. Both model IDs are hardcoded in their respective service modules.

### The genomics fan-out

`run_gene_pipeline()` is the core of the backend. It queries **19 external biomedical APIs** (Ensembl, ClinVar, gnomAD, UniProt, AlphaFold, Reactome, GTEx, STRING, Open Targets, ClinPGx, NCI GDC/TCGA, ClinGen, GWAS Catalog, HPO, Monarch, dbSNP, dbVar, GTR, MedGen, PMC) in two `asyncio.gather` waves — the second wave depends on the UniProt accession and Ensembl ID resolved by the first.

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

Three lessons worth generalising. **A 200 is not success** — check for an empty aggregation, an `errors` array, a `warnings` key, and a `content-type` that isn't JSON. **An empty result and a broken query are indistinguishable without a control**: `tests/test_upstream_contracts.py` asserts against answers that are not in reasonable doubt (BRCA1 is in the HR-repair pathways, CYP2C19 governs clopidogrel), because a test that merely asserts "returned a list" passes forever while the data is gone. And **an empty answer can be the right one** — BRCA1 genuinely has no drugs, because a tumour suppressor's loss of function is not a drug target; that is why the Open Targets test uses EGFR.

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

### External runtime dependencies

`load3Dmol()` injects the 3Dmol.js viewer from a CDN at runtime rather than bundling it; `viewerRegistry` (a module-level `Map`) exists so PDF export can pull a WebGL snapshot out of a live viewer. Protein structures are fetched from AlphaFold's public API by URL.
