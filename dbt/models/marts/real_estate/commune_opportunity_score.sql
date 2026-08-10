-- Ranks French communes on a five-factor "opportunity" heuristic: cheaper-than-average price/m2,
-- multi-year price appreciation (CAGR), transaction liquidity, population growth, and local
-- income each push the score up. Starting point for manual research, not investment advice.
--
-- Weights are proportionally rescaled from a suggested six-factor weighting (price 20 / price
-- appreciation 20 / liquidity 20 / population growth 15 / income 15 / tax+DPE 10, out of 100) to
-- the five factors this pipeline scores on (everything but tax+DPE - 90 of the original 100
-- points), so they still sum to 100.
--
-- Population growth is a real 2017-2021 CAGR (see int_insee__commune_population_cagr.sql), not
-- an approximation - the official INSEE bulk source for a fuller/more current series proved
-- unreliable to fetch from this environment; this is a community-republished dataset on a fast
-- host instead. Property tax rate isn't a full sixth weighted factor - reweighting all five
-- others is still a pending decision, not an oversight - but egregious outliers do now cost
-- points via a penalty, see "Property tax penalty" below. DPE energy ratings aren't ingested at
-- all yet. See the "How it works" tab on the dashboard for the full picture.
--
-- Minimum market size (hard cutoff): a commune/year/type can clear the 5-sale statistical-
-- reliability bar (min_reliable_transaction_count, used for the underlying price median/CAGR)
-- and still be a micro-market not worth ranking - population < min_commune_population (2,000) or
-- fewer than min_annual_transaction_count (15) qualifying sales that year are dropped from this
-- mart entirely, before the score is computed. A commune with unknown population (missing from
-- the INSEE source) is dropped too - a hard cutoff can't verify what it can't measure.
--
-- Property tax penalty: not a new weighted factor (see above), just a guard rail. Communes with
-- taux_foncier_bati above high_property_tax_threshold_pct (35%) lose points, ramping linearly to
-- the full max_property_tax_penalty_pts (15, out of the 100-point score) at 2x the threshold -
-- e.g. Caudebronde's real 73.1% rate is already past that 70% ceiling, so it takes the full
-- penalty. Communes with no tax data on file get no penalty (treated as neutral, same policy
-- used elsewhere in this model for missing CAGR/income). The raw penalty is exposed as its own
-- column (property_tax_penalty_pts) so it's visible why a commune's score dropped, not just
-- that it did.
with latest_year as (
    select max(year) as year from {{ ref('int_dvf__commune_period_stats') }}
),

dvf_latest as (
    select s.*
    from {{ ref('int_dvf__commune_period_stats') }} s
    inner join latest_year ly on s.year = ly.year
),

national_median as (
    select approx_quantiles(median_price_per_sqm, 2)[offset(1)] as national_median_price_per_sqm
    from dvf_latest
),

-- Informational only, not part of the score: what share of its department's population lives
-- in this commune right now (a size/concentration snapshot, distinct from the population_cagr
-- growth *rate* below, which is what actually scores).
department_population as (
    select code_departement, sum(population) as department_population
    from {{ ref('int_insee__commune_indicators') }}
    group by code_departement
)

select
    d.code_commune,
    d.nom_commune,
    d.code_departement,
    dep.nom_departement,
    d.type_local,
    d.year,
    d.transaction_count,
    d.median_price_per_sqm,
    d.yoy_price_change_pct,
    cagr.price_cagr,
    cagr.first_year as cagr_first_year,
    cagr.last_year as cagr_last_year,
    i.population,
    i.densite,
    i.median_disposable_income,
    pop_cagr.population_cagr,
    pop_cagr.first_year as population_cagr_first_year,
    pop_cagr.last_year as population_cagr_last_year,
    tax.taux_foncier_bati,
    tax.tax_year,
    n.national_median_price_per_sqm,
    safe_divide(d.median_price_per_sqm, n.national_median_price_per_sqm) as price_vs_national_median_ratio,
    safe_divide(d.transaction_count, i.population) as transactions_per_capita,
    safe_divide(i.population, dp.department_population) as population_share_of_department,
    -- Points deducted for high property tax, out of the 100-point score below - exposed as its
    -- own column so it's visible why a commune's score dropped, not just that it did.
    round(
        least(1.0, greatest(0, coalesce(tax.taux_foncier_bati, 0) - {{ var('high_property_tax_threshold_pct') }}) / {{ var('high_property_tax_threshold_pct') }})
        * {{ var('max_property_tax_penalty_pts') }},
        1
    ) as property_tax_penalty_pts,
    round(
        greatest(0,
            -- cheaper than the national median => up to (20/90 of 100) pts
            (1 - least(safe_divide(d.median_price_per_sqm, n.national_median_price_per_sqm), 2) / 2) * (20.0 / 90 * 100)
            -- multi-year price CAGR, capped at +/- max_price_cagr_pct => up to (20/90 of 100) pts.
            -- Communes with no reliable multi-year window (see int_dvf__commune_price_cagr) get
            -- treated as neutral (0 CAGR) rather than penalized for lacking history.
            + (least(greatest(coalesce(cagr.price_cagr, 0), -{{ var('max_price_cagr_pct') }}), {{ var('max_price_cagr_pct') }})
                / {{ var('max_price_cagr_pct') }} + 1) / 2 * (20.0 / 90 * 100)
            -- transaction liquidity (this year's sales per capita, one property type), capped at
            -- high_liquidity_transactions_per_capita => up to (20/90 of 100) pts
            + least(coalesce(safe_divide(d.transaction_count, i.population), 0) / {{ var('high_liquidity_transactions_per_capita') }}, 1) * (20.0 / 90 * 100)
            -- population growth (2017-2021 CAGR), capped at +/- max_population_cagr_pct => up to
            -- (15/90 of 100) pts. Communes with no valid CAGR (shouldn't happen for census data,
            -- but the join could still miss) are treated as neutral, same policy as price CAGR.
            + (least(greatest(coalesce(pop_cagr.population_cagr, 0), -{{ var('max_population_cagr_pct') }}), {{ var('max_population_cagr_pct') }})
                / {{ var('max_population_cagr_pct') }} + 1) / 2 * (15.0 / 90 * 100)
            -- higher local median income (capped at 30k EUR) => up to (15/90 of 100) pts
            + least(coalesce(i.median_disposable_income, 0) / 30000, 1) * (15.0 / 90 * 100)
            -- property tax penalty (see column above and the model's header comment) - a guard
            -- rail against egregious outliers, not a new weighted factor
            - least(1.0, greatest(0, coalesce(tax.taux_foncier_bati, 0) - {{ var('high_property_tax_threshold_pct') }}) / {{ var('high_property_tax_threshold_pct') }})
                * {{ var('max_property_tax_penalty_pts') }}
        ),
        1
    ) as opportunity_score
from dvf_latest d
left join {{ ref('int_insee__commune_indicators') }} i on d.code_commune = i.code_insee
left join {{ ref('int_dvf__commune_price_cagr') }} cagr
    on d.code_commune = cagr.code_commune and d.type_local = cagr.type_local
left join {{ ref('int_insee__commune_population_cagr') }} pop_cagr on d.code_commune = pop_cagr.code_insee
left join {{ ref('int_tax__commune_latest') }} tax on d.code_commune = tax.code_commune
left join {{ ref('departements') }} dep on d.code_departement = dep.code_departement
left join department_population dp on d.code_departement = dp.code_departement
cross join national_median n
where d.transaction_count >= {{ var('min_annual_transaction_count') }}  -- drop thin markets where the median is noisy
    and i.population >= {{ var('min_commune_population') }}  -- drop micro-communes; unknown population is dropped too (NULL >= n is false)
order by opportunity_score desc
