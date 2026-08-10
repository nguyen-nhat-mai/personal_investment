-- One row per ticker: cumulative return, annualized volatility, and total dividends over
-- whatever history has been ingested so far.
--
-- annualized_return/annualized_volatility are null below min_trading_days_for_return days of
-- history: (1 + avg_daily_return)^252 geometrically amplifies whatever avg_daily_return is, and
-- over just a handful of days that average is noise, not signal - blown up 252-fold it produces
-- an absurd-looking "return" (seen for real: 8,102%/year on day-one data) instead of a merely
-- unreliable one. Same policy int_dvf__commune_price_cagr already uses for thin real-estate
-- history: not enough reliable data yet is null, not a fabricated number.
with returns as (
    select * from {{ ref('int_equities__daily_returns') }}
),

per_ticker as (
    select
        ticker,
        min(date) as first_date,
        max(date) as last_date,
        count(*) as trading_days,
        avg(daily_return) as avg_daily_return,
        case when count(*) >= {{ var('min_trading_days_for_return') }}
            then stddev(daily_return) * sqrt(252)
        end as annualized_volatility,
        case when count(*) >= {{ var('min_trading_days_for_return') }}
            then power(1 + avg(daily_return), 252) - 1
        end as annualized_return
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
    t.trading_days,
    t.avg_daily_return,
    t.annualized_volatility,
    t.annualized_return,
    d.total_dividends
from per_ticker t
join first_last_price fl using (ticker)
left join dividends d using (ticker)
left join {{ ref('cac40_tickers') }} tk using (ticker)
order by period_return_pct desc
