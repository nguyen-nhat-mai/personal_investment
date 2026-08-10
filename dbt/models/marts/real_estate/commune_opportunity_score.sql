-- Ranks French communes on a simple, transparent "opportunity" heuristic: cheaper-than-average
-- price/m2, positive price momentum, and higher local income each push the score up. This is a
-- starting point for manual research, not investment advice - the weights below are a
-- reasonable first cut, tune them to what you actually care about (e.g. weight population
-- growth once a multi-year population series is available).
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
    i.population,
    i.densite,
    i.median_disposable_income,
    n.national_median_price_per_sqm,
    safe_divide(d.median_price_per_sqm, n.national_median_price_per_sqm) as price_vs_national_median_ratio,
    round(
        -- cheaper than the national median => up to 50 pts
        (1 - least(safe_divide(d.median_price_per_sqm, n.national_median_price_per_sqm), 2) / 2) * 50
        -- positive YoY momentum, capped at +/-20% => up to 25 pts
        + (least(greatest(coalesce(d.yoy_price_change_pct, 0), -0.2), 0.2) / 0.2 + 1) / 2 * 25
        -- higher local median income (capped at 30k EUR) => up to 25 pts
        + least(coalesce(i.median_disposable_income, 0) / 30000, 1) * 25,
        1
    ) as opportunity_score
from dvf_latest d
left join {{ ref('int_insee__commune_indicators') }} i on d.code_commune = i.code_insee
left join {{ ref('departements') }} dep on d.code_departement = dep.code_departement
cross join national_median n
where d.transaction_count >= 5  -- drop thin markets where the median is noisy
order by opportunity_score desc
