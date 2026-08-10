-- Latest available property tax rate per commune. The raw file is typically a single current
-- fiscal year, but this defensively picks the latest if multiple years are ever present.
select
    code_commune,
    nom_commune,
    year as tax_year,
    taux_foncier_bati
from {{ ref('stg_tax__commune_property_tax') }}
qualify row_number() over (partition by code_commune order by year desc) = 1
