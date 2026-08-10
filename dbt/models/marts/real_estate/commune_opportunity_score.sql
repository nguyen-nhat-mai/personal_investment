-- Ranks French communes on a four-factor "opportunity" heuristic: cheaper-than-average price/m2,
-- multi-year price appreciation (CAGR), transaction liquidity, and local income each push the
-- score up. Starting point for manual research, not investment advice.
--
-- Weights are proportionally rescaled from a suggested six-factor weighting (price 20 / price
-- appreciation 20 / liquidity 20 / population growth 15 / income 15 / tax+DPE 10, out of 100) to
-- the four factors this pipeline actually has data for (price, appreciation, liquidity, income -
-- 75 of the original 100 points), so they still sum to 100. Population growth and tax/DPE were
-- deliberately left out, not forgotten - see the "How it works" tab: population growth needs a
-- different INSEE dataset than the single-snapshot one ingested here, and property tax/DPE needs
-- two entirely new data sources (likely DGFiP for taxe fonciere, ADEME for DPE) neither of which
-- exists in this repo yet.
with latest_year as (
    select max(year) as year from {{ ref('int_dvf__commune_period_stats') }}
),

dvf_latest as (
    select s.*
    from {{ ref('int_dvf__commune_period_stats') }} s
    inner join latest_year ly on s.year = ly.year
),

national_median as (
    select approx_quantiles(median_price_per_sqm, 2)[offset(1)] as national_median_price_per_sqm
    from dvf_latest
)

select
    d.code_commune,
    d.nom_commune,
    d.code_departement,
    dep.nom_departement,
    d.type_local,
    d.year,
    d.transaction_count,
    d.median_price_per_sqm,
    d.yoy_price_change_pct,
    cagr.price_cagr,
    cagr.first_year as cagr_first_year,
    cagr.last_year as cagr_last_year,
    i.population,
    i.densite,
    i.median_disposable_income,
    n.national_median_price_per_sqm,
    safe_divide(d.median_price_per_sqm, n.national_median_price_per_sqm) as price_vs_national_median_ratio,
    safe_divide(d.transaction_count, i.population) as transactions_per_capita,
    round(
        -- cheaper than the national median => up to (20/75 of 100) pts
        (1 - least(safe_divide(d.median_price_per_sqm, n.national_median_price_per_sqm), 2) / 2) * (20.0 / 75 * 100)
        -- multi-year price CAGR, capped at +/- max_price_cagr_pct => up to (20/75 of 100) pts.
        -- Communes with no reliable multi-year window (see int_dvf__commune_price_cagr) get
        -- treated as neutral (0 CAGR) rather than penalized for lacking history.
        + (least(greatest(coalesce(cagr.price_cagr, 0), -{{ var('max_price_cagr_pct') }}), {{ var('max_price_cagr_pct') }})
            / {{ var('max_price_cagr_pct') }} + 1) / 2 * (20.0 / 75 * 100)
        -- transaction liquidity (this year's sales per capita, one property type), capped at
        -- high_liquidity_transactions_per_capita => up to (20/75 of 100) pts
        + least(coalesce(safe_divide(d.transaction_count, i.population), 0) / {{ var('high_liquidity_transactions_per_capita') }}, 1) * (20.0 / 75 * 100)
        -- higher local median income (capped at 30k EUR) => up to (15/75 of 100) pts
        + least(coalesce(i.median_disposable_income, 0) / 30000, 1) * (15.0 / 75 * 100),
        1
    ) as opportunity_score
from dvf_latest d
left join {{ ref('int_insee__commune_indicators') }} i on d.code_commune = i.code_insee
left join {{ ref('int_dvf__commune_price_cagr') }} cagr
    on d.code_commune = cagr.code_commune and d.type_local = cagr.type_local
left join {{ ref('departements') }} dep on d.code_departement = dep.code_departement
cross join national_median n
where d.transaction_count >= {{ var('min_reliable_transaction_count') }}  -- drop thin markets where the median is noisy
order by opportunity_score desc
