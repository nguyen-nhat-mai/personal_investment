-- Best-confirmed guess at this dataset's header (code_insee, population, superficie_km2,
-- densite, dep_code, reg_code). Verify with
-- `select * from {{ source('raw_insee', 'commune_population') }} limit 5` after the first
-- insee_ingest run and adjust the column list below if the actual header differs.
select
    code_insee,
    safe_cast(population as int64) as population,
    safe_cast(superficie_km2 as float64) as superficie_km2,
    safe_cast(densite as float64) as densite,
    dep_code as code_departement,
    reg_code as code_region,
    _ingested_at
from {{ source('raw_insee', 'commune_population') }}
where code_insee is not null
