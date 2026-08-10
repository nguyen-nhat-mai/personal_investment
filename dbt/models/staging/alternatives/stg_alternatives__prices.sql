-- One row per (ticker, date), deduped to the latest ingested version: alternatives_ingest pulls
-- a rolling 5-day window every run on purpose, so the same bar is re-loaded repeatedly. Sibling
-- to stg_equities__prices.sql - same shape, deliberately.
--
-- `where adj_close is not null` below is a defensive filter, not a hypothetical one: multi-
-- ticker yf.download batches GC=F/GLD (weekday-only) alongside BTC-USD/ETH-USD (7-day/week) in
-- one call, which unions every ticker's date index - GC=F/GLD used to get an all-NaN row for
-- every weekend/holiday only the crypto side actually trades. include/alternatives.py's
-- ingest() now drops those before upload (see its comment for the full mechanism and a
-- confirmed real-world distortion - trading_days inflated toward crypto's ~365/yr calendar
-- deflated GLD's reported annualized_return from a true ~18.9%/year to ~12.7%/year), but this
-- filter catches the raw rows already loaded under the old behavior, and any other future
-- source of a null-price row, without needing a re-ingest.
with source as (
    select * from {{ source('raw_alternatives', 'prices') }}
),

deduped as (
    select
        *,
        row_number() over (
            partition by ticker, date
            order by _ingested_at desc
        ) as _rn
    from source
)

select
    ticker,
    safe_cast(date as date) as date,
    safe_cast(open as float64) as open,
    safe_cast(high as float64) as high,
    safe_cast(low as float64) as low,
    safe_cast(close as float64) as close,
    safe_cast(adj_close as float64) as adj_close,
    safe_cast(volume as int64) as volume,
    safe_cast(dividends as float64) as dividends,
    safe_cast(stock_splits as float64) as stock_splits
from deduped
where _rn = 1
  and adj_close is not null
