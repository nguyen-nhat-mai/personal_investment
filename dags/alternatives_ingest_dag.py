"""Ingest daily OHLCV data for the alternatives watchlist (a physical-gold proxy, a paper-gold
ETF, and two major cryptocurrencies) into BigQuery. Reuses equities_ingest's weekday-evening
schedule rather than a dedicated 7-day-a-week one: crypto trades every day, but this DAG's
5-day rolling window (see `period` below) means a weekend crypto move just gets picked up by
Monday's run instead of the weekend itself - one less schedule to reason about, at the cost of
up to ~2 days' lag on weekend-only price action. Gold futures (GC=F) don't trade weekends at
all, so weekday-only is already the right cadence for that half of the watchlist.

The scheduled run always pulls a small rolling window (`period` param, default "5d") - an
efficiency/idempotency choice for the steady state (a missed run gets naturally backfilled by
the next one), NOT a limit on how much history yfinance can actually return. To backfill real
history in one shot (e.g. so alternatives_performance_summary's min_trading_days_for_return gate
clears immediately instead of waiting weeks), trigger this DAG manually with a config override -
see equities_ingest_dag.py's module docstring for the exact Airflow UI/CLI steps, identical here.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow.datasets import Dataset
from airflow.decorators import dag, task
from airflow.operators.python import get_current_context

from include.alternatives import ingest as ingest_alternatives

GCP_PROJECT = os.environ["GCP_PROJECT"]

ALTERNATIVES_DATASET = Dataset(f"bigquery://{GCP_PROJECT}/raw_alternatives/prices")


@dag(
    dag_id="alternatives_ingest",
    schedule="0 18 * * 1-5",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["alternatives", "ingestion"],
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
    params={"period": "5d"},  # override via "Trigger DAG w/ config" for a one-time backfill
)
def alternatives_ingest_dag():
    @task(outlets=[ALTERNATIVES_DATASET])
    def load_alternatives() -> int:
        period = get_current_context()["params"]["period"]
        return ingest_alternatives(project=GCP_PROJECT, period=period)

    load_alternatives()


alternatives_ingest_dag()
