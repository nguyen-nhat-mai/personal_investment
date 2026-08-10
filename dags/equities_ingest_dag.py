"""Ingest daily OHLCV data for the PEA watchlist (CAC40 + non-French EU blue chips + PEA ETFs)
into BigQuery. Scheduled weekday evenings, after every relevant European exchange's close
(Paris/Amsterdam/Frankfurt/Copenhagen/Madrid all close by 17:40 CET - 18:00 leaves a buffer).
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow.datasets import Dataset
from airflow.decorators import dag, task

from include.equities import ingest as ingest_equities

GCP_PROJECT = os.environ["GCP_PROJECT"]

EQUITIES_DATASET = Dataset(f"bigquery://{GCP_PROJECT}/raw_equities/prices")


@dag(
    dag_id="equities_ingest",
    schedule="0 18 * * 1-5",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["portfolio", "ingestion"],
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
)
def equities_ingest_dag():
    @task(outlets=[EQUITIES_DATASET])
    def load_equities() -> int:
        return ingest_equities(project=GCP_PROJECT, period="5d")

    load_equities()


equities_ingest_dag()
