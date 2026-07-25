# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working across machines

This repo is developed from more than one machine via `origin`. Claude Code sessions are stored locally per machine and do not sync, so **this file is the handoff** — `git pull` first, and record anything a future session on the other machine would otherwise have to re-derive (in-flight work, decisions made and rejected, external state like Railway/Vercel/Stripe dashboard config) in the "Current state" section below.

## Current state

Both apps are deployed: backend on Railway, frontend on Vercel. Recent work has centered on the freemium gate — anonymous users are limited client-side (3 queries) before a sign-in prompt, authenticated users are limited server-side by `FREE_QUERY_LIMIT` (currently 20). Stripe checkout and webhook entitlement granting are wired up.

Environment variables are set in the Railway and Vercel dashboards, not in the repo. The backend needs at minimum `ANTHROPIC_API_KEY` and `DATABASE_URL`; OAuth, Stripe, and stored-API-key features each stay disabled (returning 501) until their vars are set — see [config.py](genomics_backend/config.py) for the full list.

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

**Local development uses Stripe test keys; Railway uses live.** `scripts/setup_stripe_test.py` mirrors the live products into test mode and prints the `.env` lines (it refuses to run against an `sk_live_` key). `stripe listen --print-secret` supplies `STRIPE_WEBHOOK_SECRET`, and `stripe listen --forward-to localhost:8000/billing/webhook` forwards real events to the local container. Set `BACKEND_URL=http://localhost:8000` locally so the endpoint check knows not to expect a registered endpoint. `.env.live-backup` holds the live values — `cp .env.live-backup .env` switches back. Watch the boot line: `LIVE MODE` on a dev box means checkout charges a real card, and `TEST MODE` on Railway means production is quietly refusing real ones.

**Dependency drift is guarded, not merely documented.** `docker-compose.yml` bind-mounts `.:/app`, so source edits are live but installed packages are not — they live in the image. Two mechanisms close that gap:

- The Dockerfile writes the sha256 of the `requirements.txt` it installed from to `/opt/genomechat/requirements.sha256` — outside `/app`, so the bind mount cannot shadow it. [docker-entrypoint.sh](genomics_backend/docker-entrypoint.sh) compares it against the mounted file at boot and **refuses to start** on mismatch, printing the rebuild command. This replaces what used to be a `ModuleNotFoundError` traceback that read like a code bug.
- `develop.watch` in the compose file rebuilds automatically on `requirements.txt` changes under `docker compose watch`.

In production there is no bind mount, so the mounted and baked files are the same and the check is a no-op. If you add a dependency, rebuild — the container will tell you if you forget.

`genomics_backend/.dockerignore` excludes env files, `.git`, and bytecode from the build context — `.gitignore` has no effect on Docker builds, and the Dockerfile does `COPY . .`. Runtime is unaffected: compose passes secrets via `env_file`, Railway injects them from its dashboard, and pydantic-settings prefers real env vars over the `.env` file.

There is no test suite — no pytest/vitest, no test files. `test_data/` holds sample 23andMe and AncestryDNA files for manually exercising the DNA upload path; `frontend/public/sample_23andme.txt` is the in-app downloadable sample. Verify changes by running the stack and issuing real queries.

`alembic` is in `requirements.txt` but unused — see "Schema migrations" below.

## Backend architecture

### The `/chat` request pipeline

`POST /chat` in [main.py](genomics_backend/main.py) is the only endpoint that matters; everything else is legacy or supporting. It runs three stages:

1. **Interpret** — [services/query_interpreter.py](genomics_backend/services/query_interpreter.py) asks Claude to classify the message into `gene_query` / `disease_query` / `comparison_query` / `unknown`, using tool-calling (one tool per query type) rather than parsing free text. A regex `_fallback_interpret()` runs if the API key is missing or the call fails, so the endpoint never hard-fails on interpretation.
2. **Fetch** — [services/genomics_api_real.py](genomics_backend/services/genomics_api_real.py) runs the corresponding pipeline (`run_gene_pipeline` / `run_disease_pipeline`).
3. **Explain** — [services/ai_explainer.py](genomics_backend/services/ai_explainer.py) flattens the pipeline dict into a plain-text block and asks Claude to write the prose answer, with the last 4–12 turns of conversation history prepended.

`unknown` short-circuits stages 2–3 and goes straight to `answer_followup()`, which is how conversational follow-ups ("what does that mean?") work.

Two different models are used on purpose: interpretation is a cheap tool call, explanation is the long generation. Both model IDs are hardcoded in their respective service modules.

### The genomics fan-out

`run_gene_pipeline()` is the core of the backend. It queries **16 external biomedical APIs** (Ensembl, ClinVar, gnomAD, UniProt, AlphaFold, Reactome, GTEx, STRING, Open Targets, OMIM, PharmGKB, NCI GDC/TCGA, ClinGen, GWAS Catalog, HPO, Monarch) in two `asyncio.gather` waves — the second wave depends on the UniProt accession and Ensembl ID resolved by the first.

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

### Schema migrations

`create_tables()` in [database/models.py](genomics_backend/database/models.py) calls a hand-rolled `_run_migrations()` — a list of idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements, each individually try/excepted. Adding a nullable column to an existing table means appending one line there, not writing an Alembic revision. This runs on every boot.

`Settings.get_database_url()` rewrites Railway's `postgres://` to the `postgresql://` SQLAlchemy requires.

### Config

All config is [config.py](genomics_backend/config.py) `Settings` (pydantic-settings, reads `.env`, `@lru_cache`d). Add new settings there rather than reading `os.environ` directly. Note `backend_url` exists specifically because Railway's proxy strips https from `request.base_url`, which breaks the OAuth callback URL — leave that override path intact.

## Frontend architecture

[frontend/src/App.jsx](frontend/src/App.jsx) is a single ~3,300-line file containing ~40 components and the entire app. There is no router, no state library, no component directory. Tailwind utility classes inline; `App.css`/`index.css` hold only a small amount of global styling.

The structure that makes it navigable: **each key in the backend's pipeline dict has a matching display component** — `pathways` → `PathwayViewer`, `expression` → `ExpressionChart`, `interactions` → `InteractionNetwork`, `drugs` → `DrugPanel`, `gwas` → `GWASPanel`, `hpo`/`monarch` → `PhenotypePanel`, `pharmgkb` → `PharmGKBPanel`, `cancer_mutations` → `CancerMutationsPanel`, `clingen` → `ClinGenPanel`, `omim` → `OmimPanel`, `population_summary` → `PopulationFrequencyChart`, `publication_timeline` → `PublicationTimeline`, `variants` + `domains` → `LollipopMap`. `DataSection` dispatches to them. Adding a backend data source means adding a `fetch_*` in the pipeline and one panel component here.

Charts and the lollipop variant map are hand-rolled SVG — no charting library.

`API` is `import.meta.env.VITE_API_URL || "http://localhost:8000"`; set `VITE_API_URL` in Vercel.

### Personal DNA data — the privacy invariant

`parseDNAFile()` parses 23andMe, AncestryDNA, and VCF **entirely client-side**. Parsed variants live in React state and `sessionStorage` only, and are sent to `/chat` in the `personal_variants` field per-request. The backend passes them into the prompt and **never writes them to the database** — `main.py` stores `pipeline_result`, not `request.personal_variants`.

This is the product's core privacy claim, stated in the UI consent modal and in comments across both codebases. Do not add persistence, logging, or DB storage of `personal_variants` anywhere in the request path.

### External runtime dependencies

`load3Dmol()` injects the 3Dmol.js viewer from a CDN at runtime rather than bundling it; `viewerRegistry` (a module-level `Map`) exists so PDF export can pull a WebGL snapshot out of a live viewer. Protein structures are fetched from AlphaFold's public API by URL.
