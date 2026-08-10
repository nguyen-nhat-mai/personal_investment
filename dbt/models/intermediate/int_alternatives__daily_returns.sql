-- Daily return + trailing 30-trading-day volatility + running drawdown per ticker, off adjusted
-- close. Sibling to int_equities__daily_returns.sql - same shape, deliberately (see that
-- model's comments for why: geometric-vs-arithmetic annualization lives downstream in the mart,
-- not here).
with prices as (
    select
        ticker,
        date,
        adj_close,
        lag(adj_close) over (partition by ticker order by date) as prev_adj_close
    from {{ ref('stg_alternatives__prices') }}
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
    safe_divide(
        adj_close - max(adj_close) over (partition by ticker order by date rows unbounded preceding),
        max(adj_close) over (partition by ticker order by date rows unbounded preceding)
    ) as drawdown_pct
from with_returns
