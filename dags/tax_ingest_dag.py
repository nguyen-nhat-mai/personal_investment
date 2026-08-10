"""Ingest French commune-level local tax rates (property tax and others) into BigQuery.
Scheduled yearly - communes set these rates annually, no benefit to pulling more often.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow.datasets import Dataset
from airflow.decorators import dag, task

from include.tax import ingest as ingest_tax

GCP_PROJECT = os.environ["GCP_PROJECT"]

TAX_DATASET = Dataset(f"bigquery://{GCP_PROJECT}/raw_tax/commune_property_tax")


@dag(
    dag_id="tax_ingest",
    schedule="0 6 20 1 *",  # once a year, mid-to-late January
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["real_estate", "ingestion"],
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
)
def tax_ingest_dag():
    @task(outlets=[TAX_DATASET])
    def load_tax() -> int:
        return ingest_tax(project=GCP_PROJECT)

    load_tax()


tax_ingest_dag()
