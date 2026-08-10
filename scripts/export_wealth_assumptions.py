"""Export market assumptions for the docs/ Wealth simulator tab to static JSON.

Companion to export_marts.py, but deliberately separate: this script blends two kinds of
numbers into one output file, and keeping that blend visible in one place (rather than folding
it into export_marts.py's generic "select * from every mart" loop) is the point.

  - Real market data, queried from BigQuery: PEA-eligible equity return/volatility
    (equity_performance_summary) and real-estate price CAGR (department_opportunity_score).
  - Hand-set constants that are NOT market data at all - Livret A/LDDS/PEA are legal caps and
    decreed/regulated rates, Assurance Vie/SCPI-in-AV/CAT/mortgage are illustrative
    market-average assumptions with no source anywhere in this pipeline. See CONSTANTS below;
    every entry is dated and the ones most likely to drift are flagged VERIFY.

No personal data of any kind lives in this file or its output - docs/data/wealth_assumptions.json
is aggregate, public-safe assumption data only. The simulator's sliders (capital, savings,
horizon, ...) are pure client-side state in docs/index.html and are never sent anywhere.

Run manually, same workflow as export_marts.py:

    pip install -r requirements-dev.txt
    export GCP_PROJECT=your-gcp-project-id
    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-service-account.json
    python scripts/export_wealth_assumptions.py
    git add docs/data/wealth_assumptions.json && git commit -m "Refresh wealth assumptions" && git push

`dbt/models/marts/portfolio/equity_performance_summary.sql` and
`dbt/models/marts/real_estate/department_opportunity_score.sql` are where the two queried
columns (annualized_return, median_price_cagr) get defined.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import bigquery

REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = REPO_ROOT / "docs" / "data"

EQUITIES_QUERY = """
    select ticker, name, asset_type, annualized_return, annualized_volatility
    from `{project}.{dataset}.equity_performance_summary`
    where pea_eligible = true
    order by ticker
"""

# A median of department medians - department_opportunity_score.median_price_cagr is already
# itself a median across a department's communes, so this is an approximation of a true
# national median, not the real thing. Kept as a BigQuery aggregation (approx_quantiles)
# rather than recomputed from raw commune rows here, per this project's convention of doing
# aggregation in dbt/BQ and letting export scripts just shape mart rows into JSON.
REAL_ESTATE_NATIONAL_QUERY = """
    select approx_quantiles(median_price_cagr, 2)[offset(1)] as national_median_price_cagr
    from `{project}.{dataset}.department_opportunity_score`
    where median_price_cagr is not null
"""

REAL_ESTATE_BY_DEPT_QUERY = """
    select code_departement, nom_departement, median_price_cagr
    from `{project}.{dataset}.department_opportunity_score`
    where median_price_cagr is not null
    order by code_departement
"""

# Every rate/cap/threshold below is a hand-set legal/regulatory or illustrative-market figure,
# NOT sourced from BigQuery - a legally decreed rate has no more business being a dbt var than
# a market assumption invented for a UI slider does. Each entry is dated; re-verify before
# relying on this for a real decision, especially livret_a/ldds (revised by decree ~1 Feb and
# ~1 Aug each year) and the three "illustrative market average" rates (av_fonds_euro,
# scpi_in_av, cat), which drift with market/policy conditions rather than a fixed schedule.
CONSTANTS_AS_OF = "2026-08-10"

CONSTANTS = {
    "as_of": CONSTANTS_AS_OF,
    "livret_a": {
        "rate": 0.017,  # VERIFY: regulated rate, revised by decree ~1 Feb & ~1 Aug each year
        "cap": 22950,  # deposit (versements) cap - interest can push the balance a bit above
                       # this; the simulator treats it as a contribution cap, not a balance cap
    },
    "ldds": {
        "rate": 0.017,  # same regulated rate as Livret A, by law
        "cap": 12000,
    },
    "av_fonds_euro": {
        "rate": 0.025,  # VERIFY: illustrative market-average fonds-euro crediting rate;
                        # insurer-specific, typically republished ~Jan/Feb for the prior year
    },
    "scpi_in_av": {
        "distribution_rate": 0.045,  # VERIFY: illustrative SCPI average distribution rate
                                      # (ASPIM/IEIF-style). Held as unites de compte inside an
                                      # AV wrapper here, so AV tax treatment applies below, not
                                      # revenus fonciers - no data source for this anywhere in
                                      # this pipeline (DVF is direct-sale transactions, not SCPI
                                      # fund NAV/distributions)
    },
    "cat": {
        "rate": 0.025,  # VERIFY: illustrative term-deposit rate; bank/term-specific in
                        # reality, tracks ECB policy rate more than any fixed schedule
    },
    "pea": {
        "cap": 150000,  # contribution (versements) cap, PEA classique
        "income_tax_rate_after_5y": 0.0,  # 0% income tax after the 5-year holding period
        "social_charges_rate_after_5y": 0.172,  # 17.2% social charges still apply after 5y
    },
    "pfu": {  # "flat tax" - Prelevement Forfaitaire Unique, in force since 2018
        "total_rate": 0.30,
        "ir_component": 0.128,
        "ps_component": 0.172,
    },
    "av_abatement": {
        "holding_years_required": 8,
        "single": 4600,
        "couple": 9200,
        "reduced_rate_below_150k_cumulative_premiums": 0.247,  # 7.5% IR + 17.2% PS
        "rate_above_150k_cumulative_premiums": 0.30,  # standard PFU above the threshold
        # v1 simplification: the simulator always applies the 24.7% reduced rate to 100% of
        # post-abatement gains, i.e. assumes cumulative AV premiums stay under EUR150k. The
        # >150k split is a documented v2 item, not modeled here.
    },
    "tmi_brackets": [  # 2025 bareme (indexed ~yearly) - VERIFY against the current year's
        {"up_to": 11497, "rate": 0.0},
        {"up_to": 29315, "rate": 0.11},
        {"up_to": 83823, "rate": 0.30},
        {"up_to": 180294, "rate": 0.41},
        {"up_to": None, "rate": 0.45},
    ],
    "mortgage": {
        "default_rate": 0.035,  # VERIFY: illustrative 20yr fixed-rate mortgage rate
        "default_ltv": 0.80,  # 80% loan-to-value / 20% down payment
        "default_term_years": 20,
    },
}


def _rows_as_dicts(client: bigquery.Client, query: str) -> list[dict]:
    rows = list(client.query(query).result())
    records = [dict(row.items()) for row in rows]
    # BigQuery DATE/DATETIME/DECIMAL values aren't natively JSON-serializable.
    return json.loads(json.dumps(records, default=str))


def export(project: str, dataset: str) -> None:
    client = bigquery.Client(project=project)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Querying equity_performance_summary (pea_eligible) ...", file=sys.stderr)
    equities = _rows_as_dicts(client, EQUITIES_QUERY.format(project=project, dataset=dataset))
    print(f"  {len(equities)} pea-eligible tickers", file=sys.stderr)

    if equities:
        blended_default = {
            "annualized_return": sum(r["annualized_return"] for r in equities) / len(equities),
            "annualized_volatility": sum(r["annualized_volatility"] for r in equities) / len(equities),
            "method": "equal-weighted mean of annualized_return/annualized_volatility across pea_eligible=true rows in equity_performance_summary",
        }
    else:
        blended_default = None

    print("Querying department_opportunity_score (national median CAGR) ...", file=sys.stderr)
    national = _rows_as_dicts(client, REAL_ESTATE_NATIONAL_QUERY.format(project=project, dataset=dataset))
    national_median_price_cagr = national[0]["national_median_price_cagr"] if national else None

    print("Querying department_opportunity_score (by department) ...", file=sys.stderr)
    by_department = _rows_as_dicts(client, REAL_ESTATE_BY_DEPT_QUERY.format(project=project, dataset=dataset))
    print(f"  {len(by_department)} departments with a reliable CAGR", file=sys.stderr)

    output = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "project": project,
        "dataset": dataset,
        "equities": {
            "pea_eligible": equities,
            "blended_default": blended_default,
        },
        "real_estate": {
            "national_median_price_cagr": national_median_price_cagr,
            "by_department": by_department,
        },
        "constants": CONSTANTS,
    }

    out_path = OUTPUT_DIR / "wealth_assumptions.json"
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path.relative_to(REPO_ROOT)}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT"), help="GCP project ID (default: $GCP_PROJECT)")
    parser.add_argument("--dataset", default=os.environ.get("ANALYTICS_DATASET", "analytics"), help="BigQuery dataset the marts live in (default: analytics, matching dbt/profiles.yml)")
    args = parser.parse_args()

    if not args.project:
        parser.error("--project or $GCP_PROJECT is required")

    export(args.project, args.dataset)


if __name__ == "__main__":
    main()
