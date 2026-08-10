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
-- number either direction. sharpe_ratio is computed from the already-gated columns above, so it
-- nulls out for free via ordinary null propagation - no extra case/when needed. relative_
-- performance_vs_benchmark has its own separate gate (see vs_benchmark below) since it's
-- computed over a different, date-aligned window, not per_ticker's own gated columns.
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

-- relative_performance_vs_benchmark needs date-ALIGNED annualized returns on both sides, not
-- each ticker's own independently-ingested first/last date - the watchlist spans 5 exchanges
-- (Paris/Amsterdam/Frankfurt/Copenhagen/Madrid) with different holiday calendars, so "this
-- ticker's own ingested date range" can legitimately differ by a day or more ticker-to-ticker.
-- Subtracting two annualized returns computed over two different periods isn't a real excess
-- return, it's noise. Deliberately NOT applied to per_ticker's own annualized_return/
-- annualized_volatility/sharpe_ratio/max_drawdown_pct above, though: each ticker's own metrics
-- stay on its own full available history (more data = a better individual estimate) rather than
-- truncating all 50 tickers to whatever the single shortest-history ticker in the watchlist
-- allows, which would needlessly degrade 49 tickers' numbers because one thinly-traded new
-- addition joined.
benchmark_window as (
    select min(date) as bench_first_date, max(date) as bench_last_date
    from returns
    where ticker = '{{ var("benchmark_ticker") }}'
),

vs_benchmark as (
    select
        r.ticker,
        power(1 + avg(r.daily_return), 252) - 1 as aligned_annualized_return
    from returns r
    cross join benchmark_window bw  -- always exactly 1 row (a bare aggregate), safe to cross join
    where r.date between bw.bench_first_date and bw.bench_last_date
    group by r.ticker
    having count(*) >= {{ var('min_trading_days_for_return') }}
),

-- Benchmark's own aligned_annualized_return, joined into every row so relative_performance_vs_
-- benchmark is a single subtraction rather than a self-join per row. This CTE is always exactly
-- 0 or 1 row (0 if benchmark_ticker isn't in the watchlist, or doesn't itself clear
-- min_trading_days_for_return - see vs_benchmark's having clause) - joined below with
-- `left join ... on true`, NOT `cross join`: a cross join against a 0-row table would silently
-- return zero rows for the ENTIRE mart, not just null out this one column.
benchmark as (
    select aligned_annualized_return as benchmark_annualized_return
    from vs_benchmark
    where ticker = '{{ var("benchmark_ticker") }}'
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

-- Median of the first/last 5 trading days, not a single point-to-point comparison - the same
-- fix int_dvf__commune_period_stats.sql already applies to real-estate prices, for exactly the
-- same reason ("a single outlier transaction can swing the median wildly"). A single glitchy
-- adj_close value (a bad split/dividend-adjustment artifact, a data-provider hiccup) landing on
-- the literal first or last ingested day used to be able to swing period_return_pct arbitrarily
-- with zero robustness - seen for real: GLE.PA briefly showed +327% from exactly this failure
-- mode. Falls back gracefully for a ticker with fewer than 5 total days (the two 5-day windows
-- just overlap - median of an overlapping/small set is still well-defined, just noisier, which
-- is unavoidable with that little history, not a bug).
first_last_price as (
    select
        ticker,
        approx_quantiles(case when rn_asc <= 5 then adj_close end, 2)[offset(1)] as first_price,
        approx_quantiles(case when rn_desc <= 5 then adj_close end, 2)[offset(1)] as last_price
    from ranked_dates
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
    tk.isin,
    -- Derived from the ISIN's national-numbering-agency prefix (legal domicile/incorporation),
    -- NOT hand-typed - a hand-typed "defaults to FR for anything CAC40" column got 5 of 39 rows
    -- wrong in practice (ArcelorMittal/Eurofins are Luxembourg, Airbus/Stellantis/STMicro are
    -- Netherlands - all real EU cross-border merger/holding structures). This is the more
    -- defensible basis for a PEA-eligibility-adjacent column (real PEA rules turn on legal
    -- domicile), but it will disagree with Euronext's own index factsheet and casual
    -- description for exactly those 5 tickers - Euronext's own CAC 40 factsheet lists Airbus as
    -- "Country: France" despite its NL-prefixed ISIN, likely on a HQ/operations basis rather
    -- than legal domicile. Two different, both-legitimate definitions; this mart picks the one
    -- that actually matters for PEA eligibility.
    substr(tk.isin, 1, 2) as country,
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
    vb.aligned_annualized_return - b.benchmark_annualized_return as relative_performance_vs_benchmark,
    d.total_dividends,
    -- Trailing yield: dividends summed over the ingested period / last observed price. Not an
    -- annualized yield (this pipeline hasn't ingested a full year everywhere yet - see
    -- trading_days) and not dividend-adjusted for stock splits mid-period (adj_close already
    -- handles that for prices; total_dividends itself is a raw sum from stg_equities__prices,
    -- unadjusted, since a split-adjusted dividend sum would double-count the same distribution).
    safe_divide(d.total_dividends, fl.last_price) as dividend_yield_pct
from per_ticker t
join first_last_price fl using (ticker)
left join dividends d using (ticker)
left join {{ ref('pea_watchlist') }} tk using (ticker)
left join vs_benchmark vb using (ticker)
left join benchmark b on true
order by annualized_return desc
