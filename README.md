# France Investment Insights

A dbt + Airflow + BigQuery project with two purposes: learn real data-engineering patterns
(orchestration, incremental/dedup loading, staging→intermediate→marts modeling, dbt testing),
and actually help answer a real question - where in France is it worth investing spare cash
right now, in property or in a CAC40/PEA equities watchlist.

Two pipelines feed one warehouse:

```
                    ┌─────────────────┐
  data.gouv.fr  ───▶│  dvf_ingest      │──┐
  (DVF)             │  (Airflow, ~2x/yr)│  │
                    └─────────────────┘  │        ┌───────────────────┐        ┌──────────────────────────┐
                    ┌─────────────────┐  ├──────▶ │  BigQuery raw_*    │ ─────▶ │  dbt: staging →           │
  data.gouv.fr  ───▶│  insee_ingest    │──┤        │  datasets          │        │  intermediate → marts     │
  (INSEE)           │  (Airflow, yearly)│  │        └───────────────────┘        └──────────────────────────┘
                    └─────────────────┘  │                                             │              │
                    ┌─────────────────┐  │                                             ▼              ▼
  yfinance      ───▶│  equities_ingest │──┘                              commune_opportunity_score  equity_performance_summary
                    │  (Airflow, daily) │
                    └─────────────────┘

  Each ingest DAG's task declares an Airflow Dataset outlet on its raw table. dbt_transform_dag
  has no schedule of its own - Airflow triggers it once ALL FOUR raw tables have been updated
  at least once since its last run (Dataset-list scheduling is AND, not OR - see the docstring
  in dbt_transform_dag.py), then it runs `dbt deps && dbt build`.
```

## What it builds

- **`marts/real_estate/commune_opportunity_score`** — every French commune (DVF-covered
  départements), ranked on price/m² vs. the national median, year-over-year price momentum,
  and local median income.
- **`marts/portfolio/equity_performance_summary`** — one row per CAC40/PEA-ETF ticker with
  period return, annualized volatility, and dividends.

Both are starting points for your own research, not investment advice — the opportunity score
in particular uses simple, transparent, hand-picked weights (see the comments in
[`commune_opportunity_score.sql`](dbt/models/marts/real_estate/commune_opportunity_score.sql))
that you should tune to what you actually care about.

## Data sources

| Source | What | Refresh |
|---|---|---|
| [DVF](https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees) | Every property sale in France (government open data) | ~2x/year |
| [Communes et villes de France](https://www.data.gouv.fr/datasets/communes-et-villes-de-france-en-csv-excel-json-parquet-et-feather) | Population, area, density per commune | ~yearly |
| [Revenu des Français à la commune](https://www.data.gouv.fr/datasets/revenu-des-francais-a-la-commune) | INSEE Filosofi median income per commune | ~yearly |
| [yfinance](https://github.com/ranaroussi/yfinance) | Daily OHLCV/dividends for CAC40 + 2 popular PEA ETFs ([`dbt/seeds/cac40_tickers.csv`](dbt/seeds/cac40_tickers.csv)) | daily |

**Known caveats, not bugs:**
- DVF does **not** cover Alsace-Moselle (départements 57/67/68 use a different land registry)
  or most overseas départements — [`dbt/seeds/departements.csv`](dbt/seeds/departements.csv)
  excludes them.
- The two data.gouv.fr commune CSVs also aren't consistently `;` vs `,` delimited, and pandas'
  auto-sniffer got it wrong on first run — `dags/include/insee.py` now tries both explicitly.
  Column names (`code_geographique`/`libelle_geographique`/`disp_mediane` for the income file,
  not INSEE's more common `codgeo`/`libgeo`/`medXX` convention) were verified against the real
  files and are hardcoded in the staging models; if data.gouv.fr changes either schema, re-check
  `raw_insee.commune_population` / `raw_insee.commune_income` in BigQuery directly.
- CAC40 constituents and ETF tickers drift over time — the seed is a snapshot; sanity-check it
  periodically against [Euronext](https://live.euronext.com/en/markets/paris/equities-by-index/cac40).

## Setup

This is a two-part setup: a GCP project (I can't create this for you), and Docker locally.

### 1. GCP / BigQuery

1. Create a GCP project (or reuse one) and enable the BigQuery API.
2. Create a service account with the **BigQuery Data Editor** and **BigQuery Job User** roles.
3. Download its JSON key.
4. `cp docker/.env.example docker/.env`, fill in `GCP_PROJECT`, and put the key at
   `docker/keys/gcp-service-account.json` (path referenced by `GCP_KEY_PATH`). Both `docker/.env`
   and `docker/keys/` are gitignored.
5. Generate the two Airflow secrets referenced in `docker/.env.example`'s comments (Fernet key,
   webserver secret key) and fill those in too.

BigQuery's free sandbox tier covers this project's data volume without needing to attach
billing, but if you do attach billing, keep an eye on it — full-France DVF history across many
years adds up.

### 2. Docker (Airflow)

Requires Docker Desktop.

```sh
cd docker
docker compose up airflow-init   # one-time: migrates the metadata DB, creates the admin user
docker compose up -d
```

Airflow UI: http://localhost:8080 (user/pass from `AIRFLOW_ADMIN_USER`/`AIRFLOW_ADMIN_PASSWORD`
in `docker/.env`, default `admin`/`admin`).

### 3. First run

All four DAGs start **paused** (Airflow's default) - unpausing is required, not optional, and
paused DAGs don't respond to Dataset triggers either (a gotcha worth knowing before you wonder
why `dbt_transform` never fires). `dbt_transform` also needs the raw tables to exist before it
has anything to build against, so:

1. In the Airflow UI, unpause and manually trigger `insee_ingest`, `dvf_ingest`, and
   `equities_ingest` (order between them doesn't matter). `dvf_ingest` fans out into one
   Airflow task per (département, year) pair via dynamic task mapping - expect it to take a
   while even running several in parallel; ~93 départements is a lot of downloads.
2. Unpause `dbt_transform` too - it triggers itself once all three of the above have landed
   (Dataset-list scheduling is AND, not OR: see the note in `dbt_transform_dag.py`), or trigger
   it manually from the UI once you've got some real data in.
3. From then on: `dvf_ingest` runs itself every April 5 / October 5, `insee_ingest` every
   January 15, `equities_ingest` every weekday evening, and `dbt_transform` fires once all
   three ingest DAGs have landed data since its last run.

### Iterating on dbt models locally (optional)

```sh
pip install -r requirements-dev.txt
cd dbt
export GCP_PROJECT=your-gcp-project-id
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-service-account.json
dbt deps
dbt seed
dbt build
```

## Viewing the results

The pipeline only produces BigQuery tables — nothing renders them anywhere on its own. This
repo publishes a small static dashboard (`docs/`) instead, so results are viewable without
giving anyone BigQuery access:

1. **Export the marts to JSON** (after `dbt_transform` has run at least once):
   ```sh
   pip install -r requirements-dev.txt
   export GCP_PROJECT=your-gcp-project-id
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-service-account.json
   python scripts/export_marts.py
   ```
   This writes `docs/data/commune_opportunity_score.json`, `docs/data/equity_performance_summary.json`,
   and `docs/data/meta.json` (an export timestamp + row counts).
2. **Look at it locally** before publishing anything: `cd docs && python -m http.server 8000`,
   then open http://localhost:8000.
3. **Publish via GitHub Pages**: push this repo to GitHub, then in the repo's Settings → Pages,
   set Source to "Deploy from a branch", branch `main`, folder `/docs`. Your dashboard is then
   live at `https://<you>.github.io/<repo>/`.
4. **Refreshing later**: re-run `python scripts/export_marts.py`, review the diff in
   `docs/data/*.json`, then `git add docs/data && git commit && git push`. This is intentionally
   a manual step (v1 choice, see the docstring in `scripts/export_marts.py`) — no GCP
   credentials live in CI, and you see exactly what's about to go public before it does. Once
   GitHub Pages is on, this repo (and everything in `docs/`) is public.

The dashboard itself (`docs/index.html`) is a single self-contained page — no build step, no
CDN dependencies, light/dark mode, filters, a table view alongside every chart, and full
keyboard/hover tooltips.

## Repo layout

```
docker/            Dockerfile + docker-compose.yml for the Airflow stack
dags/               dvf_ingest, insee_ingest, equities_ingest, dbt_transform DAGs
dags/include/       download/parse/load logic used by the DAGs (bq.py, dvf.py, insee.py, equities.py)
dbt/
  seeds/            departements.csv (DVF-covered), cac40_tickers.csv (watchlist)
  models/staging/    1:1 cleanup per source (dvf, insee, equities)
  models/intermediate/  aggregations not yet business-facing
  models/marts/      commune_opportunity_score, equity_performance_summary
scripts/            export_marts.py (BigQuery marts -> docs/data/*.json)
docs/               static dashboard published via GitHub Pages (index.html + data/*.json)
```

## Ideas for later (not built yet)

- A BI layer (Metabase / Looker Studio) on top of the marts, for ad-hoc exploration beyond
  what the static dashboard covers.
- A "where should my cash go" mart comparing real (inflation-adjusted) yield across Livret A,
  mortgage rates, and the equities watchlist.
- A rental-yield/mortgage-cost mart on top of `commune_opportunity_score` that bakes in French
  notary fees and taxe foncière assumptions for a more realistic net-yield number.
