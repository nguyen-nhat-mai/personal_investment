-- Daily return + trailing 30-trading-day volatility per ticker, off adjusted close.
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
    ) as rolling_30d_volatility
from with_returns
