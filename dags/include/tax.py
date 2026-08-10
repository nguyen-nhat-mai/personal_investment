"""Download and load French commune-level local tax rates (property tax and others).

Source: "Fiscalite locale des particuliers" (DGFiP, via data.gouv.fr / data.economie.gouv.fr).
Dataset page: https://www.data.gouv.fr/datasets/fiscalite-locale-des-particuliers
Resource permalink (verified reachable 2026-08-10, redirects to the current
data.economie.gouv.fr OpenDataSoft export - a data.gouv.fr permalink is used here rather than
the OpenDataSoft URL directly since it's the more stable long-term link):
    https://www.data.gouv.fr/api/1/datasets/r/f48d0fcc-f732-445d-ba2d-886ec4952bce

Confirmed columns (';'-delimited, ~14MB): EXERCICE (year), DEP, COM (department-local commune
code), "INSEE COM" (the full national INSEE commune code - what we join on),
Taux_Global_TFB (aggregated building property tax rate - "taxe fonciere sur les proprietes
baties", the metric this pipeline actually uses), plus TFNB/TH/TEOM rates for other local
taxes (loaded too, unused for now - here for anyone who wants to extend the score).

This is reference data (one row per commune per year, revised annually), so each run does a
full WRITE_TRUNCATE refresh rather than appending.
"""
from __future__ import annotations

import io
import logging

import pandas as pd
import requests

from include.bq import load_dataframe, normalize_columns

logger = logging.getLogger(__name__)

RAW_DATASET = "raw_tax"
RAW_TABLE = "commune_property_tax"

SOURCE_URL = "https://www.data.gouv.fr/api/1/datasets/r/f48d0fcc-f732-445d-ba2d-886ec4952bce"


def ingest(project: str, timeout: int = 180) -> int:
    resp = requests.get(SOURCE_URL, timeout=timeout)
    resp.raise_for_status()

    try:
        df = pd.read_csv(io.BytesIO(resp.content), sep=";", dtype=str, encoding="utf-8")
    except UnicodeDecodeError:
        df = pd.read_csv(io.BytesIO(resp.content), sep=";", dtype=str, encoding="latin-1")

    df = normalize_columns(df)
    df["_ingested_at"] = pd.Timestamp.utcnow()

    rows = load_dataframe(
        df,
        project=project,
        dataset=RAW_DATASET,
        table=RAW_TABLE,
        write_disposition="WRITE_TRUNCATE",
    )
    logger.info("Loaded %s rows into raw_tax.commune_property_tax", rows)
    return rows
