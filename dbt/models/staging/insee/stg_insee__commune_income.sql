-- Column names verified against the real file on first ingest (2026-08-09):
-- code_geographique / libelle_geographique are this export's commune identifiers, and
-- disp_mediane is the median disposable income ("revenu disponible") - a stable name, not
-- year-suffixed as originally assumed before the file had actually been inspected.
select
    code_geographique as code_insee,
    libelle_geographique as nom_commune,
    safe_cast(disp_mediane as float64) as median_disposable_income,
    _ingested_at
from {{ source('raw_insee', 'commune_income') }}
where code_geographique is not null
