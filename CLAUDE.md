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

**The stale-image trap.** `docker-compose.yml` bind-mounts `.:/app`, so source edits are picked up live — but dependencies are not. `docker compose up` reuses the existing image, so after any `requirements.txt` change you get fresh code running against stale `site-packages`, and the container crash-loops on `ModuleNotFoundError` at import time. The traceback points at the import line, which makes it look like a code bug; it isn't. Rebuild with `--build`.

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

Anthropic API key resolution order in `/chat`: request body → user's server-stored encrypted key → shared server key. Stored user keys are Fernet-encrypted ([services/encryption.py](genomics_backend/services/encryption.py)) with `ENCRYPTION_KEY` and are never returned to the frontend — `/auth/me` exposes only a `has_stored_key` boolean.

Stripe: `/billing/checkout` creates a session carrying `user_id` + `purchase_type` in metadata; `/billing/webhook` reads that metadata back to grant either `byok_unlocked` (one-time unlimited) or `query_credits`. The webhook is the only place entitlements are granted.

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
