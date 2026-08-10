"""Run `dbt build` after the raw tables this project depends on have changed.

Uses Airflow's data-aware scheduling (Datasets) instead of a fixed cron - but note
`schedule=[list of Datasets]` is AND semantics, not OR: this DAG runs once ALL of the datasets
below have had at least one update since its last run, not "whenever any one of them updates"
(verified empirically 2026-08-10 - a stale comment here previously claimed OR). That's actually
convenient during a big dvf_ingest backfill (dynamic task mapping fires one outlet event per
departement/year, and AND semantics collapses all of those into a single dbt_transform trigger
instead of one per mapped task instance), but it does mean a lone incremental dvf_ingest run
(its normal biannual schedule) won't retrigger this DAG on its own unless insee/equities have
also updated since the last dbt_transform run. Revisit with explicit OR composition
(`dataset_a | dataset_b | ...`, supported since Airflow 2.9) if that turns out to matter more
than the anti-spam behavior during backfills.
"""
from __future__ import annotations

import os
from datetime import datetime

from airflow.datasets import Dataset
from airflow.decorators import dag
from airflow.operators.bash import BashOperator

GCP_PROJECT = os.environ["GCP_PROJECT"]
DBT_PROJECT_DIR = "/opt/airflow/dbt"
DBT_PROFILES_DIR = "/opt/airflow/dbt"

UPSTREAM_DATASETS = [
    Dataset(f"bigquery://{GCP_PROJECT}/raw_dvf/transactions"),
    Dataset(f"bigquery://{GCP_PROJECT}/raw_insee/commune_population"),
    Dataset(f"bigquery://{GCP_PROJECT}/raw_insee/commune_income"),
    Dataset(f"bigquery://{GCP_PROJECT}/raw_equities/prices"),
    Dataset(f"bigquery://{GCP_PROJECT}/raw_tax/commune_property_tax"),
    Dataset(f"bigquery://{GCP_PROJECT}/raw_insee/commune_population_history"),
]


@dag(
    dag_id="dbt_transform",
    schedule=UPSTREAM_DATASETS,
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["dbt", "transform"],
)
def dbt_transform_dag():
    BashOperator(
        task_id="dbt_build",
        # `dbt deps` installs dbt_utils (see dbt/packages.yml) - cheap and idempotent, so it's
        # simplest to just always run it before build rather than track whether dbt_packages/
        # is already populated (it's gitignored, so a fresh clone / fresh container starts
        # without it every time).
        bash_command=(
            f"dbt deps --project-dir {DBT_PROJECT_DIR} "
            f"&& dbt build --project-dir {DBT_PROJECT_DIR} --profiles-dir {DBT_PROFILES_DIR}"
        ),
    )


dbt_transform_dag()
