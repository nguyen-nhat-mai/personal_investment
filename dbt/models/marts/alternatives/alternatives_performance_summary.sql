-- One row per ticker in the gold/crypto watchlist: cumulative return, annualized volatility,
-- risk-adjusted metrics, and max drawdown over whatever history has been ingested so far.
--
-- Trimmed sibling of equity_performance_summary.sql - same first_last_price/per_ticker/
-- sharpe_ratio logic (median-of-5-day robust prices, geometric annualization, the
-- min_trading_days_for_return gate - see that model's header comment for the full "why", it
-- applies unchanged here), deliberately DROPPING what doesn't carry over to a 4-ticker
-- cross-asset-class watchlist:
--   - vs_benchmark/relative_performance_vs_benchmark: there's no single coherent benchmark
--     across gold and crypto the way CW8.PA is for a PEA equity watchlist - a "BTC minus gold"
--     excess return isn't a meaningful risk-adjusted comparison.
--   - isin/country/pea_eligible: not applicable (yfinance futures/ETF/crypto tickers, not
--     ISIN-bearing PEA-eligible securities).
--   - dividends/dividend_yield_pct: none of GC=F/GLD/BTC-USD/ETH-USD pays one (GLD holds
--     physical gold bars directly, no distribution) - can be re-added if a dividend-paying line
--     (e.g. a gold-miner ETF) joins the watchlist later.
with returns as (
    select * from {{ ref('int_alternatives__daily_returns') }}
),

ranked_dates as (
    select
        ticker,
        date,
        adj_close,
        row_number() over (partition by ticker order by date asc) as rn_asc,
        row_number() over (partition by ticker order by date desc) as rn_desc
    from returns
),

first_last_price as (
    select
        ticker,
        approx_quantiles(case when rn_asc <= 5 then adj_close end, 2)[offset(1)] as first_price,
        approx_quantiles(case when rn_desc <= 5 then adj_close end, 2)[offset(1)] as last_price
    from ranked_dates
    group by ticker
),

per_ticker as (
    select
        r.ticker,
        min(r.date) as first_date,
        max(r.date) as last_date,
        count(*) as trading_days,
        avg(r.daily_return) as avg_daily_return,
        case when count(*) >= {{ var('min_trading_days_for_return') }}
            then stddev(r.daily_return) * sqrt(252)
        end as annualized_volatility,
        case when count(*) >= {{ var('min_trading_days_for_return') }}
            then power(safe_divide(any_value(fl.last_price), any_value(fl.first_price)), 252.0 / count(*)) - 1
        end as annualized_return,
        case when count(*) >= {{ var('min_trading_days_for_return') }}
            then min(r.drawdown_pct)
        end as max_drawdown_pct
    from returns r
    join first_last_price fl on r.ticker = fl.ticker
    group by r.ticker
)

select
    t.ticker,
    tk.name,
    tk.asset_class,
    tk.instrument_type,
    tk.liquidity,
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
    safe_divide(t.annualized_return - {{ var('risk_free_rate_pct') }}, t.annualized_volatility) as sharpe_ratio
from per_ticker t
join first_last_price fl using (ticker)
left join {{ ref('alternatives_watchlist') }} tk using (ticker)
order by annualized_return desc
