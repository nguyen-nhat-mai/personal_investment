-- Multi-year price CAGR per commune/type, using the earliest and latest years that each
-- clear the reliability bar (>= min_reliable_transaction_count sales) - not a fixed 3-5 year
-- window, since that's simply whatever span DVF_YEARS has actually ingested (currently up to
-- 4 years: 2021-2024; 2020 isn't published by DVF at all). Requires the two reliable endpoints
-- to be at least 2 years apart, so a single pair of adjacent years doesn't masquerade as a
-- multi-year trend (that's what yoy_price_change_pct in int_dvf__commune_period_stats is for).
with reliable_years as (
    select *
    from {{ ref('int_dvf__commune_period_stats') }}
    where transaction_count >= {{ var('min_reliable_transaction_count') }}
),

endpoints as (
    select
        code_commune,
        type_local,
        min(year) as first_year,
        max(year) as last_year
    from reliable_years
    group by code_commune, type_local
    having max(year) - min(year) >= 2
),

with_prices as (
    select
        e.code_commune,
        e.type_local,
        e.first_year,
        e.last_year,
        e.last_year - e.first_year as year_span,
        first_r.median_price_per_sqm as first_year_price,
        last_r.median_price_per_sqm as last_year_price
    from endpoints e
    inner join reliable_years first_r
        on e.code_commune = first_r.code_commune and e.type_local = first_r.type_local and e.first_year = first_r.year
    inner join reliable_years last_r
        on e.code_commune = last_r.code_commune and e.type_local = last_r.type_local and e.last_year = last_r.year
)

select
    code_commune,
    type_local,
    first_year,
    last_year,
    year_span,
    first_year_price,
    last_year_price,
    safe.power(safe_divide(last_year_price, first_year_price), 1.0 / year_span) - 1 as price_cagr
from with_prices
