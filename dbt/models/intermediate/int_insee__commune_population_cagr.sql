-- Population CAGR per commune across the full span of the ingested history (2017-2021 - see
-- dags/include/insee.py for why that's the current ceiling). Unlike DVF's price CAGR, this is
-- official census data with (near-)complete coverage per commune per year, not sparse
-- transactions, so there's no "minimum reliable sample size" gate here - just a sane min/max
-- year span and a positive starting population to divide by.
with by_commune_year as (
    select code_insee, nom_commune, code_departement, year, population
    from {{ ref('stg_insee__commune_population_history') }}
    where population > 0
),

endpoints as (
    select
        code_insee,
        min(year) as first_year,
        max(year) as last_year
    from by_commune_year
    group by code_insee
    having max(year) > min(year)
),

with_pops as (
    select
        e.code_insee,
        any_value(first_r.nom_commune) as nom_commune,
        any_value(first_r.code_departement) as code_departement,
        e.first_year,
        e.last_year,
        e.last_year - e.first_year as year_span,
        any_value(first_r.population) as first_year_population,
        any_value(last_r.population) as last_year_population
    from endpoints e
    inner join by_commune_year first_r on e.code_insee = first_r.code_insee and e.first_year = first_r.year
    inner join by_commune_year last_r on e.code_insee = last_r.code_insee and e.last_year = last_r.year
    group by e.code_insee, e.first_year, e.last_year
)

select
    code_insee,
    nom_commune,
    code_departement,
    first_year,
    last_year,
    year_span,
    first_year_population,
    last_year_population,
    safe.power(safe_divide(last_year_population, first_year_population), 1.0 / year_span) - 1 as population_cagr
from with_pops
