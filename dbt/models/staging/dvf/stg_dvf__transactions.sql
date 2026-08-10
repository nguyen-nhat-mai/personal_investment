-- One row per DVF disposition line, deduped across re-ingested runs: DVF republishes a given
-- year's file with corrections, and the raw layer is append-only, so we keep only the most
-- recently ingested version of each disposition line.
with source as (
    select * from {{ source('raw_dvf', 'transactions') }}
),

deduped as (
    select
        *,
        row_number() over (
            partition by id_mutation, id_parcelle, numero_disposition
            order by _ingested_at desc
        ) as _rn
    from source
)

select
    id_mutation,
    safe_cast(date_mutation as date) as date_mutation,
    nature_mutation,
    safe_cast(valeur_fonciere as float64) as valeur_fonciere,
    code_commune,
    nom_commune,
    code_departement,
    id_parcelle,
    type_local,
    safe_cast(surface_reelle_bati as float64) as surface_reelle_bati,
    safe_cast(nombre_pieces_principales as int64) as nombre_pieces_principales,
    safe_cast(surface_terrain as float64) as surface_terrain,
    safe_cast(longitude as float64) as longitude,
    safe_cast(latitude as float64) as latitude,
    source_year,
    source_departement
from deduped
where _rn = 1
    -- keep only sales with a usable price and surface, since those drive every downstream
    -- price/m2 calculation
    and valeur_fonciere is not null
    and safe_cast(surface_reelle_bati as float64) > 0
