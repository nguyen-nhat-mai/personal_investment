"""Download and load INSEE-sourced commune reference data: population/area/density, median
household disposable income, and a multi-year population history for growth calculations.

Sources (verified reachable 2026-08-09/2026-08-10 - data.gouv.fr resource IDs are stable
permalinks that redirect to whatever the current file is, but re-check the dataset pages below
if a URL stops resolving):
  - "Communes et villes de France" (current-year population, superficie, densite, dept/region codes):
    https://www.data.gouv.fr/datasets/communes-et-villes-de-france-en-csv-excel-json-parquet-et-feather
  - "Revenu des Francais a la commune" (INSEE Filosofi median disposable income):
    https://www.data.gouv.fr/datasets/revenu-des-francais-a-la-commune
  - "Populations legales communales 2017-2021" (multi-year population, for growth - see below):
    https://www.data.gouv.fr/datasets/populations-legales-communales-2017-2021

Population history caveat: the official INSEE bulk API (api.insee.fr Melodi) that would have
the fuller/most current series proved unreliable to fetch from this environment - repeated
stalls at ~12KB/s over ~20 minutes across several retry strategies, never completing a 19MB
file. This dataset is a community republish (data.gouv.fr org "icem7") of official INSEE
"populations legales" figures, hosted on static.data.gouv.fr (the same fast, reliable host DVF
uses) - downloads in ~8 seconds. Trade-off: it's a third-party republish, not first-party INSEE
hosting, and it stops at 2021 (no newer edition existed as of 2026-08-10) - so any growth rate
computed from it reflects 2017-2021, not the current moment. Still a real multi-year trend,
just not bleeding-edge current; revisit if a fresher source turns up.

Column names were verified against the real files on 2026-08-09/2026-08-10 and are hardcoded in
the dbt staging models accordingly (stg_insee__commune_population.sql,
stg_insee__commune_income.sql - notably code_geographique/libelle_geographique/disp_mediane for
the income file, not the INSEE Filosofi codgeo/libgeo/medXX convention these exports sometimes
use elsewhere; stg_insee__commune_population_history.sql uses codgeo/pmun/annee_rp). If
data.gouv.fr changes any file's schema, ingestion will still succeed (columns are normalized
generically via `bq.normalize_columns`) but the staging SELECTs will need updating - inspect
the raw tables in BigQuery directly.

Delimiter handling: data.gouv.fr CSV exports aren't consistently ';' or ',' delimited (nor does
pandas' sep=None sniffer reliably detect which - see `_read_csv`'s comment), so both are tried
explicitly with the first one that parses into more than one column winning.

This is reference data, not a transaction log, so each run does a full WRITE_TRUNCATE refresh
rather than appending.
"""
from __future__ import annotations

import io
import logging

import pandas as pd
import requests

from include.bq import load_dataframe, normalize_columns

logger = logging.getLogger(__name__)

RAW_DATASET = "raw_insee"

SOURCES = {
    "commune_population": "https://www.data.gouv.fr/api/1/datasets/r/c63fd0b1-7987-46f6-b779-8b3ed889090c",
    "commune_income": "https://www.data.gouv.fr/api/1/datasets/r/516130bc-4dcb-47f5-8347-ae96553c43ab",
}

POPULATION_HISTORY_TABLE = "commune_population_history"
POPULATION_HISTORY_URL = (
    "https://static.data.gouv.fr/resources/populations-legales-communales-2017-2021/"
    "20240122-151058/poplegales2017-2021.parquet"
)


def _read_csv(content: bytes, encoding: str) -> pd.DataFrame:
    # data.gouv.fr CSV exports are inconsistent about delimiter (';' is the French-locale norm
    # since ',' is the decimal separator, but not every export follows it) and pandas' sep=None
    # sniffer proved unreliable in practice: on one real file it silently produced a single
    # column whose "name" was every real header smashed together, and forcing ';' on another
    # produced a hard ParserError. So: try each candidate delimiter, catch parse failures
    # outright, and only accept a result with more than one column.
    last_error: Exception | None = None
    for sep in (";", ","):
        try:
            df = pd.read_csv(io.BytesIO(content), sep=sep, dtype=str, encoding=encoding)
        except pd.errors.ParserError as exc:
            last_error = exc
            continue
        if df.shape[1] > 1:
            return df
        last_error = ValueError(f"sep={sep!r} produced a single column - wrong delimiter")
    raise ValueError(f"Could not find a working delimiter for this CSV (last error: {last_error})")


def _fetch(url: str, timeout: int = 180) -> pd.DataFrame:
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    content = resp.content
    try:
        return _read_csv(content, encoding="utf-8")
    except UnicodeDecodeError:
        return _read_csv(content, encoding="latin-1")


def _fetch_population_history(timeout: int = 60) -> pd.DataFrame:
    # Small (~1.2MB) parquet file - well within timeout even on a slow connection, unlike the
    # official INSEE API this was chosen over (see module docstring).
    resp = requests.get(POPULATION_HISTORY_URL, timeout=timeout)
    resp.raise_for_status()
    return pd.read_parquet(io.BytesIO(resp.content))


def ingest(project: str) -> dict[str, int]:
    results: dict[str, int] = {}
    for table, url in SOURCES.items():
        df = _fetch(url)
        df = normalize_columns(df)
        df["_ingested_at"] = pd.Timestamp.utcnow()

        rows = load_dataframe(
            df,
            project=project,
            dataset=RAW_DATASET,
            table=table,
            write_disposition="WRITE_TRUNCATE",
        )
        results[table] = rows
        logger.info("Loaded %s rows into raw_insee.%s", rows, table)

    df = _fetch_population_history()
    df = normalize_columns(df)
    df["_ingested_at"] = pd.Timestamp.utcnow()
    rows = load_dataframe(
        df,
        project=project,
        dataset=RAW_DATASET,
        table=POPULATION_HISTORY_TABLE,
        write_disposition="WRITE_TRUNCATE",
    )
    results[POPULATION_HISTORY_TABLE] = rows
    logger.info("Loaded %s rows into raw_insee.%s", rows, POPULATION_HISTORY_TABLE)

    return results
