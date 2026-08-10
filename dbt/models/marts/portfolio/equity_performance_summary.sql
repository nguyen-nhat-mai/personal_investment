-- One row per ticker: cumulative return, annualized volatility, and total dividends over
-- whatever history has been ingested so far.
with returns as (
    select * from {{ ref('int_equities__daily_returns') }}
),

per_ticker as (
    select
        ticker,
        min(date) as first_date,
        max(date) as last_date,
        avg(daily_return) as avg_daily_return,
        stddev(daily_return) * sqrt(252) as annualized_volatility
    from returns
    group by ticker
),

first_last_price as (
    select
        ticker,
        array_agg(adj_close order by date asc limit 1)[offset(0)] as first_price,
        array_agg(adj_close order by date desc limit 1)[offset(0)] as last_price
    from returns
    group by ticker
),

dividends as (
    select ticker, sum(dividends) as total_dividends
    from {{ ref('stg_equities__prices') }}
    group by ticker
)

select
    t.ticker,
    tk.name,
    tk.asset_type,
    tk.sector,
    tk.pea_eligible,
    t.first_date,
    t.last_date,
    fl.first_price,
    fl.last_price,
    safe_divide(fl.last_price - fl.first_price, fl.first_price) as period_return_pct,
    t.avg_daily_return,
    t.annualized_volatility,
    d.total_dividends
from per_ticker t
join first_last_price fl using (ticker)
left join dividends d using (ticker)
left join {{ ref('cac40_tickers') }} tk using (ticker)
order by period_return_pct desc
