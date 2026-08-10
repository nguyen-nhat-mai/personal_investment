"""Ingest INSEE-sourced commune reference data (population, area, density, median income)
into BigQuery. Scheduled yearly, mid-January - matches how often this reference data actually
refreshes; there's nothing gained from pulling it more often.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow.datasets import Dataset
from airflow.decorators import dag, task

from include.insee import ingest as ingest_insee

GCP_PROJECT = os.environ["GCP_PROJECT"]

INSEE_POP_DATASET = Dataset(f"bigquery://{GCP_PROJECT}/raw_insee/commune_population")
INSEE_INCOME_DATASET = Dataset(f"bigquery://{GCP_PROJECT}/raw_insee/commune_income")


@dag(
    dag_id="insee_ingest",
    schedule="0 6 15 1 *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["real_estate", "ingestion"],
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
)
def insee_ingest_dag():
    @task(outlets=[INSEE_POP_DATASET, INSEE_INCOME_DATASET])
    def load_insee() -> dict:
        return ingest_insee(project=GCP_PROJECT)

    load_insee()


insee_ingest_dag()
