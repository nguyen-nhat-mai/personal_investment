"""Download and load DVF (Demandes de Valeurs Foncières) property transactions.

DVF is France's open dataset of essentially every real-estate sale in the country, published
by data.gouv.fr / DGFiP. Dataset page:
    https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees
Per-department CSV files (verified reachable 2026-08-09):
    https://files.data.gouv.fr/geo-dvf/latest/csv/{year}/departements/{dept}.csv.gz
If this starts 404-ing wholesale, re-check the dataset page above - data.gouv.fr occasionally
restructures file layouts.

Coverage caveat (real, not a bug in this code): DVF does NOT cover Alsace-Moselle (departments
57 Moselle, 67 Bas-Rhin, 68 Haut-Rhin use the separate "livre foncier" land registry) and has
limited/no coverage for most overseas departments. dbt/seeds/departements.csv intentionally
excludes 57/67/68 and overseas codes for this reason.

Idempotency: DVF republishes a given year's file with corrections roughly twice a year, and
this DAG may also simply be re-run. The raw table is append-only (WRITE_APPEND) with an
`_ingested_at` timestamp; `stg_dvf__transactions` dedupes to the latest ingested version of
each disposition line.

Parallelism & resilience: with ~93 departements to loop through, doing this as one giant
sequential loop inside a single Airflow task was both slow and fragile - one transient failure
(a dropped connection from the machine sleeping mid-download, a momentary data.gouv.fr hiccup)
killed the entire task and lost all progress on the departements not yet reached. `ingest_one()`
below handles exactly one (departement, year) pair and is meant to be run as an Airflow
*dynamically mapped* task (see dvf_ingest_dag.py) - Airflow then runs many of these
concurrently, retries a single failed pair on its own (via the DAG's `default_args`), and
every pair's status is individually visible in the UI instead of being one opaque task. `ingest()`
is kept as a plain sequential wrapper around `ingest_one()` for non-Airflow use (a notebook,
ad hoc debugging) - it isolates failures with a try/except so one bad pair doesn't lose progress
on the rest, since there's no Airflow-level per-item retry to lean on outside a DAG run.
"""
from __future__ import annotations

import io
import logging
from typing import Iterable, Optional

import pandas as pd
import requests

from include.bq import load_dataframe, normalize_columns

logger = logging.getLogger(__name__)

BASE_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv/{year}/departements/{dept}.csv.gz"

RAW_DATASET = "raw_dvf"
RAW_TABLE = "transactions"


def _fetch_department_year(dept: str, year: int, timeout: int = 180) -> Optional[pd.DataFrame]:
    url = BASE_URL.format(year=year, dept=dept)
    resp = requests.get(url, timeout=timeout)
    if resp.status_code == 404:
        logger.warning("No DVF file for dept=%s year=%s (%s) - skipping", dept, year, url)
        return None
    resp.raise_for_status()

    # Read every column as a plain string. DVF's numeric-looking columns (surface, price,
    # room counts...) are sparse/irregular enough that letting pandas auto-infer float/int
    # dtypes here caused BigQuery's schema autodetect to disagree with pandas about at least
    # one column's type and reject the whole load. The raw table is meant to be untyped
    # anyway - stg_dvf__transactions.sql does the real safe_cast() to numeric/date types.
    df = pd.read_csv(
        io.BytesIO(resp.content),
        compression="gzip",
        dtype=str,
        low_memory=False,
    )
    df["source_departement"] = dept
    df["source_year"] = year
    return df


def ingest_one(dept: str, year: int, project: str) -> int:
    """Download and load a single (department, year) pair. Raises on failure - meant to be
    run as one Airflow dynamically-mapped task instance per pair, so Airflow's own retry and
    failure-visibility machinery handles it rather than this function swallowing errors."""
    df = _fetch_department_year(dept, year)
    if df is None or df.empty:
        return 0

    df = normalize_columns(df)
    df["_ingested_at"] = pd.Timestamp.utcnow()

    rows = load_dataframe(
        df,
        project=project,
        dataset=RAW_DATASET,
        table=RAW_TABLE,
        write_disposition="WRITE_APPEND",
    )
    logger.info("Loaded %s rows for dept=%s year=%s", rows, dept, year)
    return rows


def ingest(departements: Iterable[str], years: Iterable[int], project: str) -> int:
    """Sequential convenience wrapper around ingest_one() for non-Airflow use (a notebook, ad
    hoc debugging). The real pipeline uses dynamic task mapping instead - see dvf_ingest_dag.py
    and the module docstring. A single (dept, year) failing here is logged and skipped rather
    than aborting the whole run; raises only if *every* pair failed (a strong signal something
    is systemically wrong, e.g. the base URL moved), rather than one transient error."""
    total_rows = 0
    attempted = 0
    failed: list[tuple[str, int]] = []

    for year in years:
        for dept in departements:
            attempted += 1
            try:
                total_rows += ingest_one(dept, year, project)
            except Exception:
                logger.exception("Failed to fetch/load dept=%s year=%s - continuing", dept, year)
                failed.append((dept, year))

    if failed:
        logger.warning("%s/%s (dept, year) pairs failed: %s", len(failed), attempted, failed)
    if attempted and len(failed) == attempted:
        raise RuntimeError(
            f"All {attempted} (dept, year) pairs failed - this looks systemic "
            f"(e.g. the source URL moved), not transient. First failure logged above."
        )

    return total_rows
