"""Download daily OHLCV (+ any dividend/split actions) for the alternatives watchlist (a
physical-gold proxy, a paper-gold ETF, and two major cryptocurrencies) via yfinance and load it
into BigQuery.

Sibling to include/equities.py - same shape, deliberately. The ticker list lives in
dbt/seeds/alternatives_watchlist.csv (dbt seeds also load it into the warehouse so marts can
join against it); Airflow reads its own copy of that CSV directly here, same decoupling
equities.py already uses.

Idempotency: pulls a rolling window (`period`, default 5 trading days) on every run rather than
just "today" - see alternatives_ingest_dag.py's module docstring for why, and how to trigger a
one-off backfill of real history instead of waiting for the rolling window to accumulate it.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import List

import pandas as pd
import yfinance as yf

from include.bq import load_dataframe, normalize_columns

logger = logging.getLogger(__name__)

RAW_DATASET = "raw_alternatives"
RAW_TABLE = "prices"

TICKERS_FILE = Path(__file__).resolve().parents[2] / "dbt" / "seeds" / "alternatives_watchlist.csv"


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
        logger.warning("No alternatives data fetched this run")
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
