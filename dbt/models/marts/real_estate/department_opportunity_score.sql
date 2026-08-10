-- Department-level rollup of commune_opportunity_score, for a choropleth map view. Median
-- (not average) opportunity score, so a handful of extreme communes can't skew a whole
-- department's color on the map.
select
    code_departement,
    nom_departement,
    count(distinct code_commune) as commune_count,
    approx_quantiles(opportunity_score, 2)[offset(1)] as median_opportunity_score,
    approx_quantiles(median_price_per_sqm, 2)[offset(1)] as median_price_per_sqm,
    sum(transaction_count) as total_transactions
from {{ ref('commune_opportunity_score') }}
group by code_departement, nom_departement
order by median_opportunity_score desc
