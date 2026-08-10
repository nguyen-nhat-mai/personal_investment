"""Download daily OHLCV + dividend/split data for the PEA watchlist (CAC40 constituents,
non-French EU blue chips, and PEA-eligible ETFs) via yfinance and load it into BigQuery.

The ticker list lives in dbt/seeds/pea_watchlist.csv (dbt seeds also load it into the
warehouse so marts can join against it). Airflow reads its own copy of that CSV directly
here rather than depending on dbt having already run, to keep the two tools decoupled.

Idempotency: pulls a rolling window (`period`, default 5 trading days) on every run rather than
just "today", so a missed/failed run gets naturally backfilled on the next one. The raw table
is append-only; `stg_equities__prices` dedupes to the latest ingested version of each
(ticker, date). The small default window is purely a steady-state efficiency choice, not a
limit - yfinance happily returns years of history in one call, so a larger `period` (e.g. "2y")
is the right way to backfill real history in one shot rather than waiting for the daily rolling
window to slowly accumulate it - see equities_ingest_dag.py's module docstring for how to
trigger that as a one-off.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import List

import pandas as pd
import yfinance as yf

from include.bq import load_dataframe, normalize_columns

logger = logging.getLogger(__name__)

RAW_DATASET = "raw_equities"
RAW_TABLE = "prices"

TICKERS_FILE = Path(__file__).resolve().parents[2] / "dbt" / "seeds" / "pea_watchlist.csv"


def _load_tickers() -> List[str]:
    df = pd.read_csv(TICKERS_FILE)
    return df["ticker"].dropna().unique().tolist()


def ingest(project: str, period: str = "5d") -> int:
    tickers = _load_tickers()

    data = yf.download(
        tickers=tickers,
        period=period,
        interval="1d",
        group_by="ticker",
        auto_adjust=False,
        actions=True,
        threads=True,
        progress=False,
    )

    frames = []
    for ticker in tickers:
        try:
            sub = data[ticker].copy() if len(tickers) > 1 else data.copy()
        except KeyError:
            logger.warning("No data returned for %s - skipping", ticker)
            continue
        if sub.dropna(how="all").empty:
            logger.warning("Empty data for %s - skipping", ticker)
            continue
        sub = sub.reset_index()
        sub["ticker"] = ticker
        frames.append(sub)

    if not frames:
        logger.warning("No equity data fetched this run")
        return 0

    df = pd.concat(frames, ignore_index=True)
    df = normalize_columns(df)
    df["_ingested_at"] = pd.Timestamp.utcnow()

    return load_dataframe(
        df,
        project=project,
        dataset=RAW_DATASET,
        table=RAW_TABLE,
        write_disposition="WRITE_APPEND",
    )
