"""Ingest daily OHLCV data for the PEA watchlist (CAC40 + non-French EU blue chips + PEA ETFs)
into BigQuery. Scheduled weekday evenings, after every relevant European exchange's close
(Paris/Amsterdam/Frankfurt/Copenhagen/Madrid all close by 17:40 CET - 18:00 leaves a buffer).

The scheduled run always pulls a small rolling window (`period` param, default "5d") - that's
an efficiency/idempotency choice for the steady state (a missed run gets naturally backfilled
by the next one), NOT a limit on how much history yfinance can actually return. To backfill
real history in one shot (e.g. so equity_performance_summary's min_trading_days_for_return gate
clears immediately instead of waiting weeks for the rolling window to accumulate it one day at
a time), trigger this DAG manually with a config override instead of waiting:

    Airflow UI: DAG list -> equities_ingest -> Trigger DAG w/ config -> {"period": "2y"}
    CLI:        airflow dags trigger equities_ingest --conf '{"period": "2y"}'

`period` accepts any yfinance period string ("1mo", "6mo", "1y", "2y", "5y", "max", ...) - see
include/equities.py:ingest(). One backfill run is enough; subsequent scheduled runs go back to
the "5d" default automatically (params only apply to the run they're passed to).
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow.datasets import Dataset
from airflow.decorators import dag, task
from airflow.operators.python import get_current_context

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
    params={"period": "5d"},  # override via "Trigger DAG w/ config" for a one-time backfill
)
def equities_ingest_dag():
    @task(outlets=[EQUITIES_DATASET])
    def load_equities() -> int:
        period = get_current_context()["params"]["period"]
        return ingest_equities(project=GCP_PROJECT, period=period)

    load_equities()


equities_ingest_dag()
