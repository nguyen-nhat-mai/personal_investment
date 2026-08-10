"""Ingest French real-estate transactions (DVF) into BigQuery.

Schedule: DVF is republished by data.gouv.fr roughly twice a year (spring + autumn), so this
DAG runs on the 5th of April and October rather than on a tighter cadence - there's simply no
new data in between. Its outlet Dataset is what wakes up dbt_transform_dag.

Parallelism: ~93 departements x however many years are in DVF_YEARS is a lot of independent
downloads, so this uses Airflow dynamic task mapping (`.expand()`) - one mapped task instance
per (departement, year) pair - instead of one big sequential Python loop in a single task.
Airflow runs up to `max_active_tis_per_dag` of them concurrently, retries a single failed pair
on its own (via default_args below), and each pair's success/failure is individually visible
in the UI rather than being one opaque task that dies on the first bad network call.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

import pandas as pd
from airflow.datasets import Dataset
from airflow.decorators import dag, task

from include.dvf import ingest_one

GCP_PROJECT = os.environ["GCP_PROJECT"]
DEPARTEMENTS_SEED = "/opt/airflow/dbt/seeds/departements.csv"
DVF_YEARS = [int(y) for y in os.environ.get("DVF_YEARS", "2020,2021,2022,2023,2024").split(",")]

# Concurrent (dept, year) downloads/loads for this task. Bounded deliberately - this all runs
# on one local machine (Docker Desktop), and data.gouv.fr is a shared public service; 8 is
# enough to meaningfully parallelize ~93 departements without hammering either.
DVF_TASK_CONCURRENCY = int(os.environ.get("DVF_TASK_CONCURRENCY", "8"))

DVF_DATASET = Dataset(f"bigquery://{GCP_PROJECT}/raw_dvf/transactions")


@dag(
    dag_id="dvf_ingest",
    schedule="0 6 5 4,10 *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["real_estate", "ingestion"],
    # A ~93-departement fan-out is long enough to hit a transient network blip (including the
    # machine sleeping mid-run); each mapped task instance below gets its own retries.
    default_args={"retries": 2, "retry_delay": timedelta(minutes=10)},
)
def dvf_ingest_dag():
    @task
    def list_targets() -> list[dict]:
        departements = pd.read_csv(DEPARTEMENTS_SEED, dtype=str)["code_departement"].tolist()
        return [{"dept": dept, "year": year} for year in DVF_YEARS for dept in departements]

    @task(outlets=[DVF_DATASET], max_active_tis_per_dag=DVF_TASK_CONCURRENCY)
    def load_dvf_one(target: dict) -> int:
        return ingest_one(dept=target["dept"], year=target["year"], project=GCP_PROJECT)

    load_dvf_one.expand(target=list_targets())


dvf_ingest_dag()
