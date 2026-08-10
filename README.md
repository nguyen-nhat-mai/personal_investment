# France Investment Insights

A dbt + Airflow + BigQuery project with two purposes: learn real data-engineering patterns
(orchestration, incremental/dedup loading, staging→intermediate→marts modeling, dbt testing),
and actually help answer a real question - where in France is it worth investing spare cash
right now, in property or in a CAC40/PEA equities watchlist.

Several pipelines feed one warehouse:

```
                    ┌─────────────────┐
  data.gouv.fr  ───▶│  dvf_ingest      │──┐
  (DVF)             │  (Airflow, ~2x/yr)│  │
                    └─────────────────┘  │
                    ┌─────────────────┐  │
  data.gouv.fr  ───▶│  insee_ingest    │──┤        ┌───────────────────┐        ┌──────────────────────────┐
  (INSEE)           │  (Airflow, yearly)│  ├──────▶ │  BigQuery raw_*    │ ─────▶ │  dbt: staging →           │
                    └─────────────────┘  │        │  datasets          │        │  intermediate → marts     │
                    ┌─────────────────┐  │        └───────────────────┘        └──────────────────────────┘
  data.gouv.fr  ───▶│  tax_ingest      │──┤                                             │              │
  (DGFiP)           │  (Airflow, yearly)│  │                                             ▼              ▼
                    └─────────────────┘  │                              commune_opportunity_score  equity_performance_summary
                    ┌─────────────────┐  │
  yfinance      ───▶│  equities_ingest │──┘
                    │  (Airflow, daily) │
                    └─────────────────┘

  Each ingest DAG's task declares an Airflow Dataset outlet on its raw table. dbt_transform_dag
  has no schedule of its own - Airflow triggers it once ALL raw tables have been updated at
  least once since its last run (Dataset-list scheduling is AND, not OR - see the docstring
  in dbt_transform_dag.py), then it runs `dbt deps && dbt build`.
```

## What it builds

- **`marts/real_estate/commune_opportunity_score`** — every French commune (DVF-covered
  départements) with at least 2,000 population and 15 qualifying sales in the latest year (hard
  cutoffs dropping micro-markets, on top of the separate 5-sale bar that governs whether a given
  year's median price is statistically trustworthy — see the model's header comment), ranked on
  five factors: price/m² vs. the national median, multi-year price CAGR (see
  [`int_dvf__commune_price_cagr.sql`](dbt/models/intermediate/int_dvf__commune_price_cagr.sql)),
  transaction liquidity (sales per capita), population growth (2017–2021 CAGR, see
  [`int_insee__commune_population_cagr.sql`](dbt/models/intermediate/int_insee__commune_population_cagr.sql)),
  and local median income. Weights are proportionally rescaled from a suggested six-factor model
  (only DPE energy ratings aren't in the pipeline yet — see the dashboard's "How it works" tab).
  Property tax rate (DGFiP, `taux_foncier_bati`) and % of department population are also carried
  as informational columns; property tax additionally applies a guard-rail penalty (up to 15
  points, ramping in above a 35% rate) against egregious outliers like Caudebronde's real 73.1%
  — not a full sixth weighted factor, see `property_tax_penalty_pts`. Excludes non-market
  transactions (forced auctions, exchanges, expropriations) and implausible prices (below
  €100/m² or above €30,000/m² — both found via a real data anomaly, see
  [`int_dvf__commune_period_stats.sql`](dbt/models/intermediate/int_dvf__commune_period_stats.sql)).
- **`marts/real_estate/department_opportunity_score`** — department-level median rollup of the
  above, for the dashboard's choropleth map.
- **`marts/portfolio/equity_performance_summary`** — one row per CAC40/PEA-ETF ticker with
  period return, annualized volatility, and dividends.

All are starting points for your own research, not investment advice — the opportunity score
in particular uses simple, transparent, hand-picked weights (see the comments in
[`commune_opportunity_score.sql`](dbt/models/marts/real_estate/commune_opportunity_score.sql),
or the "How is this calculated?" panel on the dashboard itself) that you should tune to what
you actually care about.

## Data sources

| Source | What | Refresh |
|---|---|---|
| [DVF](https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees) | Every property sale in France (government open data) | ~2x/year |
| [Communes et villes de France](https://www.data.gouv.fr/datasets/communes-et-villes-de-france-en-csv-excel-json-parquet-et-feather) | Population, area, density per commune | ~yearly |
| [Revenu des Français à la commune](https://www.data.gouv.fr/datasets/revenu-des-francais-a-la-commune) | INSEE Filosofi median income per commune | ~yearly |
| [Fiscalité locale des particuliers](https://www.data.gouv.fr/datasets/fiscalite-locale-des-particuliers) | DGFiP property tax rate (`taux_foncier_bati`) per commune | ~yearly |
| [Populations légales communales 2017-2021](https://www.data.gouv.fr/datasets/populations-legales-communales-2017-2021) | Year-by-year population per commune, for the population-growth score factor (community republish of INSEE figures, org "icem7" — see [`dags/include/insee.py`](dags/include/insee.py) for why) | static (2017–2021) |
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
CDN dependencies, light/dark mode, filters, a table view alongside every chart, full
keyboard/hover tooltips, a France choropleth map (département boundaries from
[gregoiredavid/france-geojson](https://github.com/gregoiredavid/france-geojson), MIT-licensed,
committed at `docs/data/departements.geojson`), and an in-page "How is this calculated?"
methodology disclosure.

## Repo layout

```
docker/            Dockerfile + docker-compose.yml for the Airflow stack
dags/               dvf_ingest, insee_ingest, tax_ingest, equities_ingest, dbt_transform DAGs
dags/include/       download/parse/load logic used by the DAGs (bq.py, dvf.py, insee.py, tax.py, equities.py)
dbt/
  seeds/            departements.csv (DVF-covered), cac40_tickers.csv (watchlist)
  models/staging/    1:1 cleanup per source (dvf, insee, equities)
  models/intermediate/  aggregations not yet business-facing
  models/marts/      commune_opportunity_score, department_opportunity_score, equity_performance_summary
scripts/            export_marts.py (BigQuery marts -> docs/data/*.json)
docs/               static dashboard published via GitHub Pages (index.html + data/*.json + departements.geojson)
```

## Ideas for later (not built yet)

- A BI layer (Metabase / Looker Studio) on top of the marts, for ad-hoc exploration beyond
  what the static dashboard covers.
- A "where should my cash go" mart comparing real (inflation-adjusted) yield across Livret A,
  mortgage rates, and the equities watchlist.
- A rental-yield/mortgage-cost mart on top of `commune_opportunity_score` that bakes in French
  notary fees and taxe foncière assumptions for a more realistic net-yield number.
