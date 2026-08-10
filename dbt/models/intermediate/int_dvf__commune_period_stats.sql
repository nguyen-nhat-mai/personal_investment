-- Median price/m2 and transaction volume per commune, year, and property type, plus the
-- prior-year median for a simple year-over-year comparison used by the opportunity-score mart.
--
-- Two data-quality filters, both discovered from a real anomaly (Jarnages/Maison showed a
-- +2,933,233% YoY change - see git history for the investigation):
--   1. nature_mutation excludes Adjudication (forced auction), Echange (property swap), and
--      Expropriation - none of those reflect a market price, and a single one of them in a
--      thin-volume commune can wreck its median. Vente and "Vente en l'etat futur d'achevement"
--      (off-plan/new-build sales) are both kept - both are genuine market transactions.
--   2. price_per_sqm has a technical floor (EUR 100/m2) and ceiling (EUR 30,000/m2). Neither
--      is a market judgment - they exclude obviously-broken entries (a EUR 1 family-transfer
--      "sale" recorded as a Vente on the low end; a mis-reported surface_reelle_bati producing
--      a multi-million-EUR/m2 "median" on the high end - found in several communes where it
--      was clearly a units/data-entry error, not real transactions). EUR 30,000/m2 is a
--      generous ceiling - even ultra-prime central Paris rarely exceeds it.
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
        and nature_mutation not in ('Adjudication', 'Echange', 'Expropriation')
        and safe_divide(valeur_fonciere, surface_reelle_bati) between 100 and 30000
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
    -- Only trust the comparison when the PRIOR year also clears the reliability bar - a low
    -- current-year count is already handled downstream (commune_opportunity_score filters on
    -- it directly), but a thin prior year poisons this ratio even when the current year is fine.
    case
        when prev.transaction_count >= {{ var('min_reliable_transaction_count') }}
            then safe_divide(cur.median_price_per_sqm - prev.median_price_per_sqm, prev.median_price_per_sqm)
        else null
    end as yoy_price_change_pct
from by_commune_year cur
left join by_commune_year prev
    on cur.code_commune = prev.code_commune
    and cur.type_local = prev.type_local
    and cur.year = prev.year + 1
