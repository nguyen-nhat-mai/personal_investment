# France Investment Insights

A dbt + Airflow + BigQuery project with two purposes: learn real data-engineering patterns
(orchestration, incremental/dedup loading, staging→intermediate→marts modeling, dbt testing),
and actually help answer a real question - where in France is it worth investing spare cash
right now, in property or in a PEA equities watchlist.

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
- **`marts/portfolio/equity_performance_summary`** — one row per PEA watchlist ticker (CAC40 +
  non-French EU blue chips + PEA ETFs, see [`dbt/seeds/pea_watchlist.csv`](dbt/seeds/pea_watchlist.csv))
  with period return (a median of the first/last 5 trading days' price, not a single
  point-to-point comparison — the latter let one glitchy data point swing the figure
  arbitrarily; GLE.PA briefly showed +327% from exactly that), annualized return (a proper
  geometric annualization of that same robust period return — `power(last/first, 252/
  trading_days) - 1` — not `power(1 + avg_daily_return, 252) - 1`, an earlier version of the
  formula that raised the arithmetic mean of daily returns to the 252nd power; arithmetic mean
  is always ≥ geometric mean, more so for volatile stocks, so that formula produced real,
  seriously distorted figures — GLE.PA briefly showed 121%/year against a true
  geometrically-annualized figure around 25–30%/year for the same prices), annualized
  volatility, max drawdown, Sharpe ratio (against a dated
  illustrative risk-free rate, `risk_free_rate_pct`), simple excess return vs. a benchmark
  (`benchmark_ticker`, CW8.PA by default — not a Beta-adjusted CAPM alpha, and computed over a
  date-aligned common window with the benchmark rather than each ticker's own independently-
  ingested first/last date, since this watchlist spans 5 exchanges with different holiday
  calendars), dividends, and dividend yield. Everything is computed off adjusted close, never
  raw close. `country` is derived from each ticker's ISIN prefix (legal domicile), not
  hand-typed — that caught 5 real mistakes in the original ticker list (ArcelorMittal/Eurofins
  are Luxembourg-domiciled, Airbus/Stellantis/STMicroelectronics are Netherlands-domiciled,
  despite all five being reputationally "French" CAC 40 names — Euronext's own factsheet lists
  all five as "Country: France" on a HQ/operations basis, not a legal-domicile one; both are
  legitimate, this mart picks the one that matters for real PEA eligibility). ISIN verification
  is tiered, not uniform — see [`dbt/seeds/_seeds.yml`](dbt/seeds/_seeds.yml). Return/
  volatility/drawdown/Sharpe/vs.-benchmark are all null below `min_trading_days_for_return` (60)
  days of ingested history for a ticker — short-history extrapolation fails in both directions
  (an absurd return from a noisy few-day average, or a falsely-flattering near-zero drawdown
  from not having lived through a bad week yet), so this project nulls rather than fabricates
  either way, see the model's header comment.

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
| [yfinance](https://github.com/ranaroussi/yfinance) | Daily OHLCV/dividends for the PEA watchlist: CAC40 + non-French EU blue chips + PEA ETFs ([`dbt/seeds/pea_watchlist.csv`](dbt/seeds/pea_watchlist.csv)) | daily |

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
- PEA watchlist constituents drift over time — the seed is a snapshot; sanity-check CAC40 names
  periodically against [Euronext](https://live.euronext.com/en/markets/paris/equities-by-index/cac40).
  Legal PEA eligibility (the EU/EEA-headquarters rule for direct stocks, or a fund's UCITS
  wrapper structure for ETFs) and whether a specific broker's PEA custody actually supports a
  given foreign-listed line aren't always the same thing — verify with your broker before
  treating any row's `pea_eligible = true` as investment advice.

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

The dashboard itself (`docs/`) is a handful of plain static files — no build step, no npm
install, no CDN dependencies, still just `<link>`/`<script src>` tags a browser reads directly.
`index.html` holds markup only; `style.css` and `js/*.js` are split by concern (`utils.js`/
`charts.js` are shared primitives, `real-estate.js`/`portfolio.js`/`wealth-sim.js` are one per
tab, `main.js` is the bootstrap that ties them together — load order in `index.html` matters,
each depends on the ones before it). Light/dark mode, filters, a table view alongside every
chart, full keyboard/hover tooltips, a France choropleth map (département boundaries from
[gregoiredavid/france-geojson](https://github.com/gregoiredavid/france-geojson), MIT-licensed,
committed at `docs/data/departements.geojson`), and an in-page "How is this calculated?"
methodology disclosure per tab.

## Repo layout

```
docker/            Dockerfile + docker-compose.yml for the Airflow stack
dags/               dvf_ingest, insee_ingest, tax_ingest, equities_ingest, dbt_transform DAGs
dags/include/       download/parse/load logic used by the DAGs (bq.py, dvf.py, insee.py, tax.py, equities.py)
dbt/
  seeds/            departements.csv (DVF-covered), pea_watchlist.csv (watchlist)
  models/staging/    1:1 cleanup per source (dvf, insee, equities)
  models/intermediate/  aggregations not yet business-facing
  models/marts/      commune_opportunity_score, department_opportunity_score, equity_performance_summary
scripts/            export_marts.py (BigQuery marts -> docs/data/*.json)
docs/               static dashboard published via GitHub Pages
docs/style.css       all dashboard CSS
docs/js/             utils.js, charts.js (shared) -> real-estate.js, portfolio.js, wealth-sim.js (per tab) -> main.js (bootstrap)
docs/data/           *.json marts export + departements.geojson
```

## Ideas for later (not built yet)

- A BI layer (Metabase / Looker Studio) on top of the marts, for ad-hoc exploration beyond
  what the static dashboard covers.
- A "where should my cash go" mart comparing real (inflation-adjusted) yield across Livret A,
  mortgage rates, and the equities watchlist.
- A rental-yield/mortgage-cost mart on top of `commune_opportunity_score` that bakes in French
  notary fees and taxe foncière assumptions for a more realistic net-yield number.
