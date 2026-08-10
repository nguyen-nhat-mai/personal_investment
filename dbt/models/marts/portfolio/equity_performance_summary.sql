-- One row per ticker: cumulative return, annualized volatility, risk-adjusted metrics, and
-- total dividends over whatever history has been ingested so far.
--
-- annualized_return/annualized_volatility/max_drawdown_pct are all null below
-- min_trading_days_for_return days of history. Two different failure modes, one policy: return
-- and volatility get blown UP into an absurd number over too little history ((1 +
-- avg_daily_return)^252 amplifies noise 252-fold - seen for real: 8,102%/year on day-one data),
-- while drawdown gets pushed FALSELY DOWN (a ticker with 4 good days looks like a 0%-drawdown,
-- zero-risk asset) - both are "not enough reliable data yet", same policy
-- int_dvf__commune_price_cagr already uses for thin real-estate history: null, not a fabricated
-- number either direction. sharpe_ratio and relative_performance_vs_benchmark are computed from
-- the already-gated columns below, so they null out for free via ordinary null propagation -
-- no extra case/when needed for either.
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
        end as annualized_return,
        case when count(*) >= {{ var('min_trading_days_for_return') }}
            then min(drawdown_pct)
        end as max_drawdown_pct
    from returns
    group by ticker
),

-- Benchmark's own annualized_return, joined into every row so relative_performance_vs_benchmark
-- is a single subtraction rather than a self-join per row. This CTE is always exactly 0 or 1
-- row (0 if the configured benchmark_ticker isn't in the watchlist, 1 otherwise) - joined below
-- with `left join ... on true`, NOT `cross join`: a cross join against a 0-row table would
-- silently return zero rows for the entire mart, not just null out this one column, if
-- benchmark_ticker is ever misconfigured or temporarily missing.
benchmark as (
    select annualized_return as benchmark_annualized_return
    from per_ticker
    where ticker = '{{ var("benchmark_ticker") }}'
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
    tk.country,
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
    t.max_drawdown_pct,
    safe_divide(t.annualized_return - {{ var('risk_free_rate_pct') }}, t.annualized_volatility) as sharpe_ratio,
    t.annualized_return - b.benchmark_annualized_return as relative_performance_vs_benchmark,
    d.total_dividends
from per_ticker t
join first_last_price fl using (ticker)
left join dividends d using (ticker)
left join {{ ref('pea_watchlist') }} tk using (ticker)
left join benchmark b on true
order by period_return_pct desc
