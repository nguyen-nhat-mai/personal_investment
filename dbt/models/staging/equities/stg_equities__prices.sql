-- One row per (ticker, date), deduped to the latest ingested version: equities_ingest pulls a
-- rolling 5-day window every run on purpose, so the same bar is re-loaded repeatedly.
--
-- `where adj_close is not null` below is defensive: multi-ticker yf.download unions every
-- requested ticker's date index, so a ticker closed on a date another watchlist member traded
-- (e.g. a national holiday one of this watchlist's 5 exchanges observes and another doesn't)
-- can get an all-NaN placeholder row. include/equities.py's ingest() now drops those before
-- upload (see its comment - the same bug, much smaller effect here than the gold/crypto
-- calendar mismatch that surfaced it in include/alternatives.py), but this filter catches
-- anything already loaded under the old behavior, or any other future null-price source.
with source as (
    select * from {{ source('raw_equities', 'prices') }}
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
