-- Joins population/area/density with median income per commune into one reference row.
select
    pop.code_insee,
    pop.code_departement,
    pop.code_region,
    pop.population,
    pop.superficie_km2,
    pop.densite,
    inc.median_disposable_income
from {{ ref('stg_insee__commune_population') }} pop
left join {{ ref('stg_insee__commune_income') }} inc
    on pop.code_insee = inc.code_insee
