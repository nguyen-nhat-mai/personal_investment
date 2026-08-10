select
    insee_com as code_commune,
    libcom as nom_commune,
    safe_cast(exercice as int64) as year,
    safe_cast(taux_global_tfb as float64) as taux_foncier_bati,
    _ingested_at
from {{ source('raw_tax', 'commune_property_tax') }}
where insee_com is not null
