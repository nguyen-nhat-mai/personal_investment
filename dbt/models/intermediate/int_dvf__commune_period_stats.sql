-- Median price/m2 and transaction volume per commune, year, and property type, plus the
-- prior-year median for a simple year-over-year comparison used by the opportunity-score mart.
with transactions as (
    select
        code_commune,
        nom_commune,
        code_departement,
        type_local,
        source_year as year,
        safe_divide(valeur_fonciere, surface_reelle_bati) as price_per_sqm
    from {{ ref('stg_dvf__transactions') }}
    where type_local in ('Maison', 'Appartement')
),

by_commune_year as (
    select
        code_commune,
        any_value(nom_commune) as nom_commune,
        code_departement,
        type_local,
        year,
        count(*) as transaction_count,
        approx_quantiles(price_per_sqm, 2)[offset(1)] as median_price_per_sqm
    from transactions
    group by code_commune, code_departement, type_local, year
)

select
    cur.code_commune,
    cur.nom_commune,
    cur.code_departement,
    cur.type_local,
    cur.year,
    cur.transaction_count,
    cur.median_price_per_sqm,
    prev.median_price_per_sqm as prior_year_median_price_per_sqm,
    safe_divide(
        cur.median_price_per_sqm - prev.median_price_per_sqm,
        prev.median_price_per_sqm
    ) as yoy_price_change_pct
from by_commune_year cur
left join by_commune_year prev
    on cur.code_commune = prev.code_commune
    and cur.type_local = prev.type_local
    and cur.year = prev.year + 1
