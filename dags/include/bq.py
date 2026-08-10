"""Shared BigQuery loading helpers used by every ingestion module in this package."""
from __future__ import annotations

import logging
import re

import pandas as pd
from google.cloud import bigquery

logger = logging.getLogger(__name__)

_ACCENTS = str.maketrans("éèêëàâïîôùûç", "eeeeaaiiouuc")


def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize incoming CSV headers to BigQuery-safe, stable snake_case.

    BigQuery column names must be letters/numbers/underscores and can't start with a digit.
    Source CSVs are inconsistent (accents, spaces, mixed case - "Adj Close", "code_commune",
    "CODGEO"...), so every loader routes through this before `load_dataframe` to keep the raw
    tables' schemas predictable for dbt sources.
    """

    def clean(col: str) -> str:
        col = str(col).strip().lower().translate(_ACCENTS)
        col = re.sub(r"[^0-9a-z_]+", "_", col)
        col = re.sub(r"_+", "_", col).strip("_")
        if col and col[0].isdigit():
            col = f"c_{col}"
        return col or "col"

    df = df.copy()
    df.columns = [clean(c) for c in df.columns]
    return df


def load_dataframe(
    df: pd.DataFrame,
    *,
    project: str,
    dataset: str,
    table: str,
    write_disposition: str = "WRITE_APPEND",
) -> int:
    """Load a DataFrame into `project.dataset.table` with schema autodetect.

    Creates the dataset (EU location, matching French source data) if it doesn't exist yet.
    Returns the number of rows loaded.
    """
    client = bigquery.Client(project=project)

    dataset_ref = bigquery.DatasetReference(project, dataset)
    try:
        client.get_dataset(dataset_ref)
    except Exception:
        bq_dataset = bigquery.Dataset(dataset_ref)
        bq_dataset.location = "EU"
        client.create_dataset(bq_dataset, exists_ok=True)
        logger.info("Created BigQuery dataset %s.%s", project, dataset)

    table_id = f"{project}.{dataset}.{table}"
    job_config = bigquery.LoadJobConfig(
        write_disposition=write_disposition,
        autodetect=True,
    )
    job = client.load_table_from_dataframe(df, table_id, job_config=job_config)
    job.result()
    logger.info("Loaded %s rows into %s (%s)", job.output_rows, table_id, write_disposition)
    return job.output_rows
