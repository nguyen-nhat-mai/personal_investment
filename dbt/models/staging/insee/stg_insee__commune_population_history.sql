-- One row per (commune, year), 2017-2021. pmun ("population municipale") is INSEE's standard
-- official population figure - the same concept as the `population` column elsewhere in this
-- project, just year-stamped here instead of a single current snapshot.
select
    codgeo as code_insee,
    libgeo as nom_commune,
    coddep as code_departement,
    safe_cast(annee_rp as int64) as year,
    safe_cast(pmun as int64) as population,
    _ingested_at
from {{ source('raw_insee', 'commune_population_history') }}
where codgeo is not null
