-- Daily return + trailing 30-trading-day volatility + running drawdown per ticker, off
-- adjusted close.
with prices as (
    select
        ticker,
        date,
        adj_close,
        lag(adj_close) over (partition by ticker order by date) as prev_adj_close
    from {{ ref('stg_equities__prices') }}
),

with_returns as (
    select
        ticker,
        date,
        adj_close,
        safe_divide(adj_close - prev_adj_close, prev_adj_close) as daily_return
    from prices
)

select
    ticker,
    date,
    adj_close,
    daily_return,
    stddev(daily_return) over (
        partition by ticker order by date rows between 29 preceding and current row
    ) as rolling_30d_volatility,
    -- Drawdown at this point in time vs. this ticker's own running peak so far (not a trailing
    -- window like volatility above - a drawdown is measured from the highest price seen to
    -- date, however long ago that was). equity_performance_summary.max_drawdown_pct takes
    -- min(drawdown_pct) per ticker - the single worst point in whatever history is ingested.
    safe_divide(
        adj_close - max(adj_close) over (partition by ticker order by date rows unbounded preceding),
        max(adj_close) over (partition by ticker order by date rows unbounded preceding)
    ) as drawdown_pct
from with_returns
