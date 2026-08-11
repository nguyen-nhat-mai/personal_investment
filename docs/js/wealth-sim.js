"use strict";
// Wealth simulator tab. Depends on utils.js and charts.js (fmt*, svgEl, addStatTile,
// wireTableToggle, renderTable) - must load after both.

// Every euro fills Livret A then LDDS first (safety-first, unconditional); risk tolerance
// only governs how the OVERFLOW beyond those caps splits between the preservation tier
// (Assurance Vie fonds euro / SCPI-in-AV / CAT) and the growth tier (PEA / leveraged real
// estate). See the tab's own methodology panel for the full explanation.
//
// These are DEFAULTS only, used to seed the allocation sliders when a risk-tolerance preset is
// picked (see initWealthSimulator's applyAllocationPreset) - the actual split/mix used by
// wealthComputeProjection always comes from params.split/tier3Mix/tier4Mix/tier4OngoingMix,
// read live from the sliders, since the user can drag any of them away from these defaults
// (which is what flips the risk-tolerance select to "Customized").
var WEALTH_TIER_SPLIT_DEFAULT = {
  conservative: { preservation: 0.70, growth: 0.30 },
  balanced:     { preservation: 0.50, growth: 0.50 },
  aggressive:   { preservation: 0.25, growth: 0.75 }
};
// v1 simplification: within the growth tier, PEA/leveraged real estate/alternatives defaults to
// a fixed 3-way split regardless of risk tolerance - only the preservation/growth ratio itself
// is risk-driven by default, to avoid an under-specified second "how aggressive is the mix" axis
// - though the user can now override this split directly via the allocation sliders. Weights are
// hand-picked and illustrative (same treatment the original 50/50 PEA/real-estate split got),
// not derived from anything - alternatives gets the smallest slice, reflecting that it's the
// newest, most speculative-in-practice leg of the three (gold+crypto's realized volatility is
// materially higher than a diversified PEA ETF blend or national median real-estate CAGR).
var WEALTH_TIER4_SUBSPLIT_DEFAULT = { pea: 0.45, realEstate: 0.35, alternatives: 0.20 };
// Equal-thirds default for the preservation tier's AV Fonds Euro / SCPI-in-AV / CAT mix -
// same "no reason to prefer one over another by default" reasoning as the growth tier above.
var WEALTH_TIER3_SUBSPLIT_DEFAULT = { avFondsEuro: 1 / 3, scpiInAv: 1 / 3, cat: 1 / 3 };

// Turns a set of relative slider weights into fractions that sum to 1 - lets each allocation
// slider act as an independent weight (drag one, others don't need to be nudged to keep a sum
// of 100) rather than a literal percentage. Falls back to an equal split if every weight is 0
// (all sliders dragged to the floor), so a caller always gets a well-formed mix back.
function wealthNormalize(weights) {
  var keys = Object.keys(weights);
  var sum = keys.reduce(function (s, k) { return s + Math.max(0, weights[k]); }, 0);
  var out = {};
  keys.forEach(function (k) {
    out[k] = sum > 0 ? Math.max(0, weights[k]) / sum : 1 / keys.length;
  });
  return out;
}

var WEALTH_SERIES = [
  { key: "livretA", label: "Livret A", color: "var(--wealth-livret-a)" },
  { key: "ldds", label: "LDDS", color: "var(--wealth-ldds)" },
  { key: "avFondsEuro", label: "AV Fonds Euro", color: "var(--wealth-av-fonds-euro)" },
  { key: "scpiInAv", label: "SCPI-in-AV", color: "var(--wealth-scpi-av)" },
  { key: "cat", label: "CAT", color: "var(--wealth-cat)" },
  { key: "pea", label: "PEA", color: "var(--wealth-pea)" },
  { key: "realEstateEquity", label: "Real estate (equity)", color: "var(--wealth-real-estate)" },
  { key: "alternatives", label: "Alternatives (gold+crypto)", color: "var(--wealth-alternatives)" }
];

// bucket: { balance, contributionsCum }. cap: Infinity for uncapped tier-3 vehicles. Caps
// in real French law are on contributions (versements), not balance - market growth
// legitimately pushes the balance above the cap, so contributionsCum is tracked separately.
function wealthDepositInto(bucket, amount, cap) {
  var room = Math.max(0, cap - bucket.contributionsCum);
  var used = Math.min(amount, room);
  bucket.contributionsCum += used;
  bucket.balance += used;
  return amount - used; // leftover, routed further down the waterfall
}

function wealthWaterfallAllocate(amount, state, C, split) {
  var afterLivretA = wealthDepositInto(state.livretA, amount, C.livret_a.cap);
  var afterLdds = wealthDepositInto(state.ldds, afterLivretA, C.ldds.cap);
  return { tier3: afterLdds * split.preservation, tier4: afterLdds * split.growth };
}

// One-time leveraged position, sized once from the growth-tier split of STARTING capital
// only (see methodology panel: monthly savings routed to the growth tier go 100% to PEA
// instead, since fractional-house purchases aren't realistic). Appreciation-only - no
// rental income assumed, since DVF has no rent data, only sale prices.
//
// shocks (see wealthComputeProjection) rescale the property's PRICE trajectory only, from each
// shock's year onward - the mortgage's outstandingBalance is a fixed amortization schedule tied
// to the original loan, not the market price, so a crash doesn't forgive (or inflate) what's
// owed. Multiple shocks compound multiplicatively.
function wealthBuildRealEstatePosition(equity0, mortgageCfg, priceCagr, shocks) {
  if (!(equity0 > 0)) return null;
  shocks = shocks || [];
  var ltv = mortgageCfg.default_ltv;
  var propertyPrice0 = equity0 / (1 - ltv);
  var principal = propertyPrice0 * ltv;
  var rMonthly = mortgageCfg.default_rate / 12;
  var nMonths = mortgageCfg.default_term_years * 12;
  var monthlyPayment = rMonthly === 0
    ? principal / nMonths
    : principal * (rMonthly * Math.pow(1 + rMonthly, nMonths)) / (Math.pow(1 + rMonthly, nMonths) - 1);

  function outstandingBalance(afterMonths) {
    var m = Math.min(afterMonths, nMonths);
    if (m <= 0) return principal;
    if (rMonthly === 0) return Math.max(0, principal - monthlyPayment * m);
    var bal = principal * Math.pow(1 + rMonthly, m)
      - monthlyPayment * (Math.pow(1 + rMonthly, m) - 1) / rMonthly;
    return Math.max(0, bal);
  }

  function shockMultiplier(year) {
    return shocks.reduce(function (m, s) { return s.year <= year ? m * (1 + s.magnitude) : m; }, 1);
  }

  return {
    propertyPrice0: propertyPrice0,
    principal: principal,
    equityAtYear: function (year) {
      var value = propertyPrice0 * Math.pow(1 + priceCagr, year) * shockMultiplier(year);
      var equity = value - outstandingBalance(year * 12);
      // Floored at 0 in the unshocked (base-case) path - a modeling simplification, since
      // without a crash only an extreme negative price CAGR could push this below 0. A
      // configured market-stress-test shock is deliberately allowed to go negative - being
      // underwater on the mortgage after a crash is a real, worth-surfacing outcome, not
      // something to hide behind a floor.
      return shocks.length ? equity : Math.max(0, equity);
    }
  };
}

// Multiplies the market-priced vehicles' balances (PEA, SCPI-in-AV, alternatives - NOT the
// capital-guaranteed Livret A/LDDS/AV Fonds Euro/CAT, and not real estate, which gets its own
// price-curve treatment in wealthBuildRealEstatePosition above) by every shock scheduled for
// this exact year. Called once at year 0 (right after the initial lump-sum deposit) and once at
// the start of each loop year in wealthComputeProjection, before that year's growth/contribution
// - so money contributed AFTER a crash year isn't retroactively marked down, only the balance
// that already existed is.
function wealthApplyMarketShocksForYear(state, shocks, year) {
  shocks.forEach(function (s) {
    if (s.year !== year) return;
    state.pea.balance *= (1 + s.magnitude);
    state.scpiInAv.balance *= (1 + s.magnitude);
    state.alternatives.balance *= (1 + s.magnitude);
  });
}

function wealthSnapshot(year, state, realEstate) {
  var reEquity = realEstate ? realEstate.equityAtYear(year) : 0;
  var total = state.livretA.balance + state.ldds.balance + state.avFondsEuro.balance
    + state.scpiInAv.balance + state.cat.balance + state.pea.balance + reEquity
    + state.alternatives.balance;
  return {
    year: year,
    livretA: state.livretA.balance, ldds: state.ldds.balance,
    avFondsEuro: state.avFondsEuro.balance, scpiInAv: state.scpiInAv.balance,
    cat: state.cat.balance, pea: state.pea.balance, realEstateEquity: reEquity,
    alternatives: state.alternatives.balance,
    totalNetWorth: total
  };
}

// Year-by-year loop, PRE-TAX balances only - French capital-gains tax is due on realization
// (withdrawal), not annually on paper gains, so tax is applied once at the end instead (see
// wealthComputeAfterTaxLiquidation). Returns { rows, state, realEstate } - state and
// realEstate carry the cost-basis info the tax step needs.
//
// PEA growth is BigQuery-sourced (assumptions.equities.etf_blended_default) with a defensive
// clamp, same treatment as real estate below - belt and suspenders against compounding an
// extreme number 20-40 years forward, same spirit as this project's existing
// max_price_cagr_pct/max_population_cagr_pct dbt vars. Hardcoded (not read from
// assumptions.constants) on purpose: this is the last line of defense, so it shouldn't depend
// on the same payload it's defending against being well-formed.
var WEALTH_MAX_REAL_ESTATE_CAGR = 0.15; // +/-15%/year, matches dbt's max_price_cagr_pct
var WEALTH_MAX_EQUITY_ANNUALIZED_RETURN = 0.20; // +/-20%/year guard rail on the live ETF blend
var WEALTH_EQUITY_ANNUALIZED_RETURN = 0.07; // fallback only, used when etf_blended_default isn't available yet - see wealthComputeProjection
var WEALTH_REAL_ESTATE_CAGR_FALLBACK = 0.03; // matches export_wealth_assumptions.py's real_estate_fallback
// Same +/-20%/year ceiling as equities, and for the same reason: BTC/ETH's realized annualized
// return over a short ingestion window can be extreme, and compounding that uncapped over a
// 20-40yr horizon would reproduce exactly the kind of blow-up this guard rail already exists to
// prevent for PEA (see equity_performance_summary.sql's header comment for a real example of
// that failure mode).
var WEALTH_MAX_ALTERNATIVES_ANNUALIZED_RETURN = 0.20;
var WEALTH_ALTERNATIVES_ANNUALIZED_RETURN = 0.06; // fallback only, matches export_wealth_assumptions.py's alternatives_fallback
// Minimum down payment (apport) to realistically trigger a leveraged property purchase - a
// EUR500 "down payment" doesn't buy any real French property. Below this, the growth-tier real
// estate allocation goes to SCPI-in-AV instead (same "real estate flavor" exposure within the
// preservation tier's AV wrapper, just unlevered). Lower bound of a EUR15k-20k range.
var WEALTH_MIN_REAL_ESTATE_DOWN_PAYMENT = 15000;
// Ongoing (year-by-year) growth-tier contributions split between PEA and alternatives only -
// real estate doesn't participate here (it's a one-time lump sum sized from starting capital
// only, see wealthBuildRealEstatePosition's comment: monthly savings are too small to buy
// fractional houses, unlike gold/crypto which can genuinely be dollar-cost-averaged into). The
// actual ratio (params.tier4OngoingMix) is derived from the growth-tier allocation sliders'
// PEA:alternatives weights, renormalized after dropping real estate - see readAllocation in
// initWealthSimulator - so it tracks whatever the user (or risk-tolerance preset) has PEA and
// alternatives set to, not a separate hardcoded ratio.
function wealthClamp(v, maxAbs, fallback) {
  if (typeof v !== "number" || !isFinite(v)) return fallback;
  return Math.max(-maxAbs, Math.min(maxAbs, v));
}

// PEA growth uses the live equal-weighted average annualized_return across the watchlist's
// ETFs only (assumptions.equities.etf_blended_default) - not the all-ticker blend, and not
// any single ticker. A PEA investor buying a diversified index tracker (CW8.PA world,
// PE500.PA S&P500, ...) gets a materially different, much less noisy return profile than one
// stock-picking individual large caps, so blending stocks and ETFs together would represent
// neither strategy - see scripts/export_wealth_assumptions.py's etf_blended_default. Clamped
// to +/-20%/year (WEALTH_MAX_EQUITY_ANNUALIZED_RETURN) and falls back to a fixed ~7%/year if
// no ETF has enough trading-day history yet - same defensive treatment real estate's CAGR gets,
// guarding against a short/volatile data window getting compounded 20-40 years forward without
// discarding real data once it's trustworthy. Pulled out as its own function (not inlined in
// wealthComputeProjection) so the table headers below can label each column with the exact same
// resolved rate the projection actually used, instead of a second, possibly-drifting copy of
// this logic.
function wealthResolveGrowthAssumptions(assumptions) {
  var etfBlend = assumptions.equities && assumptions.equities.etf_blended_default;
  // liquid_blended_default (GLD/BTC/ETH), not the all-ticker blended_default (which would
  // include the illiquid GC=F physical-gold proxy) - same "don't compound an illiquid/
  // non-representative proxy" reasoning as PEA's ETF-only blend above.
  var altBlend = assumptions.alternatives && assumptions.alternatives.liquid_blended_default;
  return {
    peaAnnualizedReturn: wealthClamp(etfBlend && etfBlend.annualized_return, WEALTH_MAX_EQUITY_ANNUALIZED_RETURN, WEALTH_EQUITY_ANNUALIZED_RETURN),
    realEstateCagr: wealthClamp(assumptions.real_estate.national_median_price_cagr, WEALTH_MAX_REAL_ESTATE_CAGR, WEALTH_REAL_ESTATE_CAGR_FALLBACK),
    alternativesAnnualizedReturn: wealthClamp(altBlend && altBlend.annualized_return, WEALTH_MAX_ALTERNATIVES_ANNUALIZED_RETURN, WEALTH_ALTERNATIVES_ANNUALIZED_RETURN)
  };
}

function wealthComputeProjection(params, assumptions) {
  var C = assumptions.constants;
  var growth = wealthResolveGrowthAssumptions(assumptions);
  var eq = { annualized_return: growth.peaAnnualizedReturn };
  var reCagr = growth.realEstateCagr;
  var altReturn = growth.alternativesAnnualizedReturn;
  var split = params.split;
  // tier3Mix (AV Fonds Euro/SCPI-in-AV/CAT) and tier4Mix (PEA/real estate/alternatives) drive
  // BOTH the initial lump-sum deposit and the preservation-tier overflow-routing below;
  // tier4OngoingMix (PEA/alternatives only, real estate excluded) drives the per-year
  // contribution loop instead - see initWealthSimulator's readAllocation for how these three are
  // derived from the allocation sliders (or a risk-tolerance preset, if unmodified).
  var tier3Mix = params.tier3Mix;
  var tier4Mix = params.tier4Mix;
  // Optional market-stress-test shocks - [{ year, magnitude }], magnitude e.g. -0.30 for a -30%
  // crash. Defaults to none, so every existing call site (risk-tolerance/inflation comparisons,
  // the main projection) that doesn't set params.shocks behaves exactly as before. See
  // wealthApplyMarketShocksForYear and wealthBuildRealEstatePosition for how each vehicle
  // responds.
  var shocks = params.shocks || [];

  var state = {
    livretA: { balance: 0, contributionsCum: 0 },
    ldds: { balance: 0, contributionsCum: 0 },
    avFondsEuro: { balance: 0, contributionsCum: 0 },
    scpiInAv: { balance: 0, contributionsCum: 0 },
    cat: { balance: 0, contributionsCum: 0 },
    pea: { balance: 0, contributionsCum: 0 },
    alternatives: { balance: 0, contributionsCum: 0 }
  };

  var init = wealthWaterfallAllocate(params.startingCapital, state, C, split);
  wealthDepositInto(state.avFondsEuro, init.tier3 * tier3Mix.avFondsEuro, Infinity);
  wealthDepositInto(state.scpiInAv, init.tier3 * tier3Mix.scpiInAv, Infinity);
  wealthDepositInto(state.cat, init.tier3 * tier3Mix.cat, Infinity);
  // PEA's EUR150k contribution cap can bind even on the initial deposit for a large starting
  // capital - route any overflow into the (uncapped) preservation tier rather than losing it,
  // same treatment the ongoing per-year contribution loop below uses.
  var peaOverflowInit = wealthDepositInto(state.pea, init.tier4 * tier4Mix.pea, C.pea.cap);
  wealthDepositInto(state.avFondsEuro, peaOverflowInit * tier3Mix.avFondsEuro, Infinity);
  wealthDepositInto(state.scpiInAv, peaOverflowInit * tier3Mix.scpiInAv, Infinity);
  wealthDepositInto(state.cat, peaOverflowInit * tier3Mix.cat, Infinity);
  // No contribution cap on alternatives (unlike PEA's real EUR150k one), so no overflow
  // handling needed here.
  wealthDepositInto(state.alternatives, init.tier4 * tier4Mix.alternatives, Infinity);

  // Below the minimum realistic down payment, no leveraged property purchase triggers - route
  // that portion to SCPI-in-AV instead (not the general preservation-tier mix: this money was
  // earmarked for "real estate flavor" exposure specifically, and SCPI-in-AV is the closest
  // unlevered equivalent already in this model).
  var reEquityCandidate = init.tier4 * tier4Mix.realEstate;
  var realEstate = null;
  if (reEquityCandidate >= WEALTH_MIN_REAL_ESTATE_DOWN_PAYMENT) {
    realEstate = wealthBuildRealEstatePosition(reEquityCandidate, C.mortgage, reCagr, shocks);
  } else {
    wealthDepositInto(state.scpiInAv, reEquityCandidate, Infinity);
  }

  // A shock scheduled for year 0 hits right after the initial lump-sum deposit above, before
  // any growth has even happened - "the market crashes the moment I invest".
  wealthApplyMarketShocksForYear(state, shocks, 0);

  var annualContribution = params.monthlySavings * 12;
  var rows = [wealthSnapshot(0, state, realEstate)];
  // CAT interest is taxed annually as it accrues (30% PFU, always - not cheaper-of-PFU-or-
  // bareme like AV/PEA get at liquidation, since French CAT interest doesn't get a holding-
  // period-based deferral the way AV/PEA do), so only the NET interest compounds forward -
  // unlike every other vehicle here, state.cat.balance is already after-tax at every point in
  // time, not gross-pending-liquidation-tax. Tracked cumulatively so the UI can still show a
  // complete "total tax paid over the whole horizon" figure alongside the liquidation-time tax.
  var catTaxPaidCumulative = 0;

  for (var year = 1; year <= params.horizonYears; year++) {
    // A shock scheduled for this year hits the balance carried in from last year, before this
    // year's own growth and contribution - so it lands as "the market dropped during year N"
    // rather than retroactively marking down money that arrives later in the same year.
    wealthApplyMarketShocksForYear(state, shocks, year);
    state.livretA.balance *= (1 + C.livret_a.rate);
    state.ldds.balance *= (1 + C.ldds.rate);
    state.avFondsEuro.balance *= (1 + C.av_fonds_euro.rate);
    state.scpiInAv.balance *= (1 + C.scpi_in_av.distribution_rate);
    var catInterest = state.cat.balance * C.cat.rate;
    var catTaxThisYear = catInterest * C.pfu.total_rate;
    state.cat.balance += catInterest - catTaxThisYear;
    catTaxPaidCumulative += catTaxThisYear;
    state.pea.balance *= (1 + eq.annualized_return);
    state.alternatives.balance *= (1 + altReturn);

    var yr = wealthWaterfallAllocate(annualContribution, state, C, split);
    wealthDepositInto(state.avFondsEuro, yr.tier3 * tier3Mix.avFondsEuro, Infinity);
    wealthDepositInto(state.scpiInAv, yr.tier3 * tier3Mix.scpiInAv, Infinity);
    wealthDepositInto(state.cat, yr.tier3 * tier3Mix.cat, Infinity);
    // Ongoing tier-4 splits between PEA and alternatives only (see params.tier4OngoingMix -
    // real estate doesn't get ongoing contributions), until PEA's EUR150k contribution cap is
    // hit; overflow past that falls back to the (uncapped) preservation tier instead of
    // vanishing - a real investor keeps saving through a different vehicle once PEA is maxed,
    // not stops saving. Alternatives has no such cap, so no overflow handling needed there.
    var peaOverflow = wealthDepositInto(state.pea, yr.tier4 * params.tier4OngoingMix.pea, C.pea.cap);
    wealthDepositInto(state.avFondsEuro, peaOverflow * tier3Mix.avFondsEuro, Infinity);
    wealthDepositInto(state.scpiInAv, peaOverflow * tier3Mix.scpiInAv, Infinity);
    wealthDepositInto(state.cat, peaOverflow * tier3Mix.cat, Infinity);
    wealthDepositInto(state.alternatives, yr.tier4 * params.tier4OngoingMix.alternatives, Infinity);

    rows.push(wealthSnapshot(year, state, realEstate));
  }
  return { rows: rows, state: state, realEstate: realEstate, catTaxPaidCumulative: catTaxPaidCumulative };
}

// Assurance Vie (and SCPI-in-AV, same wrapper): social charges always apply to the full
// gain; below the 8-year mark it's PFU-or-bareme like any other capital income; at/above
// 8 years, an abatement (single/couple) shields part of the gain from income tax, and the
// remainder gets the reduced 24.7% rate (7.5% IR + 17.2% PS - isolated below) or your
// bareme, whichever is cheaper. Assumes cumulative AV premiums stay under EUR150k (the
// >150k split is a documented v2 item, not modeled here).
function wealthTaxAV(gain, holdingYears, household, tmiRate, C) {
  var ps = C.pfu.ps_component * gain;
  if (holdingYears < C.av_abatement.holding_years_required) {
    return ps + Math.min(gain * (C.pfu.total_rate - C.pfu.ps_component), gain * tmiRate);
  }
  var abatement = household === "couple" ? C.av_abatement.couple : C.av_abatement.single;
  var taxable = Math.max(0, gain - abatement);
  var reducedIr = C.av_abatement.reduced_rate_below_150k_cumulative_premiums - C.pfu.ps_component;
  return ps + taxable * Math.min(reducedIr, tmiRate);
}

// PEA: 0% income tax + 17.2% social charges after the 5-year mark; before that, PFU as a
// simplification (early PEA withdrawal has its own, harsher, closure-triggering rules in
// reality - not modeled here, flagged in the methodology panel).
function wealthTaxPEA(gain, holdingYears, C) {
  if (holdingYears < 5) return gain * C.pfu.total_rate;
  return gain * C.pea.social_charges_rate_after_5y;
}

// Alternatives (gold + crypto): flat 30% PFU on the realized gain, no holding-period discount -
// a v1 simplification. Real French rules are more nuanced and instrument-specific: crypto
// disposals by individuals are broadly taxed at the flat 30% PFU already (so this is close to
// right for BTC-USD/ETH-USD), but physical/paper gold has its own optional flat-rate-per-sale
// regime (taxe forfaitaire sur les metaux precieux) as an alternative to capital-gains tax -
// not modeled here, flagged in the methodology panel.
function wealthTaxAlternatives(gain, C) {
  return gain * C.pfu.total_rate;
}

// Applied once, to the final year's accumulated gain per vehicle - not annually. Livret A
// and LDDS are always tax-free, so they're absent here. CAT is also absent here - its tax is
// already paid annually as it accrues (see wealthComputeProjection's catTaxPaidCumulative),
// so state.cat.balance is already net and taxing it again here would double-count. Real estate
// is shown pre-tax in v1 (French property capital-gains taper relief is its own multi-year
// schedule - a v2 item). Alternatives (gold+crypto) uses a flat 30% PFU on the gain, no
// holding-period discount - see wealthTaxAlternatives. taxPaid here is tax due AT LIQUIDATION
// only - add catTaxPaidCumulative for the complete lifetime tax picture (the caller does this
// for display).
function wealthComputeAfterTaxLiquidation(finalRow, state, params, C) {
  var avGain = Math.max(0, (state.avFondsEuro.balance + state.scpiInAv.balance) - (state.avFondsEuro.contributionsCum + state.scpiInAv.contributionsCum));
  var peaGain = Math.max(0, state.pea.balance - state.pea.contributionsCum);
  var altGain = Math.max(0, state.alternatives.balance - state.alternatives.contributionsCum);

  var avTax = wealthTaxAV(avGain, params.horizonYears, params.household, params.tmiRate, C);
  var peaTax = wealthTaxPEA(peaGain, params.horizonYears, C);
  var altTax = wealthTaxAlternatives(altGain, C);
  var taxPaid = avTax + peaTax + altTax;

  return { total: finalRow.totalNetWorth - taxPaid, taxPaid: taxPaid };
}

// "If every euro you put in had merely tracked inflation instead of being invested, what would
// you have at the end?" - same contribution schedule as the real projection (starting capital
// at year 0, annualContribution at the end of each year 1..horizonYears), each euro compounding
// at the assumed inflation rate instead of any vehicle's return. This is the benchmark the
// Inflation comparison panel measures your actual after-tax total against - a fair,
// timing-matched "did I even keep up with inflation" bar, not just today's total contributed.
function wealthComputeInflationBenchmark(params) {
  var infl = params.inflationRate;
  var fv = params.startingCapital * Math.pow(1 + infl, params.horizonYears);
  var annualContribution = params.monthlySavings * 12;
  for (var year = 1; year <= params.horizonYears; year++) {
    fv += annualContribution * Math.pow(1 + infl, params.horizonYears - year);
  }
  return fv;
}

function renderWealthChart(container, legendEl, rows) {
  container.innerHTML = "";
  legendEl.innerHTML = "";

  var W = 900, H = 340;
  var margin = { top: 12, right: 16, bottom: 34, left: 64 };
  var innerW = W - margin.left - margin.right, innerH = H - margin.top - margin.bottom;
  var xMax = rows[rows.length - 1].year || 1;
  var yMax = Math.max.apply(null, rows.map(function (r) { return r.totalNetWorth; }).concat([1])) * 1.08;

  function sx(year) { return margin.left + (year / xMax) * innerW; }
  function sy(v) { return margin.top + innerH - (v / yMax) * innerH; }

  var svg = svgEl("svg", { class: "wealth-chart", viewBox: "0 0 " + W + " " + H, role: "img",
    "aria-label": "Net worth by vehicle, year by year" });

  var GRID = 4;
  for (var i = 0; i <= GRID; i++) {
    var gy = margin.top + (innerH / GRID) * i;
    svg.appendChild(svgEl("line", { class: "gridline", x1: margin.left, x2: margin.left + innerW, y1: gy, y2: gy }));
    var yVal = yMax - (yMax / GRID) * i;
    var yLabel = svgEl("text", { class: "axis-label", x: margin.left - 8, y: gy + 3, "text-anchor": "end" });
    yLabel.textContent = fmtEUR0.format(yVal);
    svg.appendChild(yLabel);
  }
  for (var j = 0; j <= GRID; j++) {
    var gx = margin.left + (innerW / GRID) * j;
    var xVal = (xMax / GRID) * j;
    var xLabel = svgEl("text", { class: "axis-label", x: gx, y: H - 8, "text-anchor": "middle" });
    xLabel.textContent = "Yr " + Math.round(xVal);
    svg.appendChild(xLabel);
  }
  svg.appendChild(svgEl("line", { class: "axis-line", x1: margin.left, x2: margin.left, y1: margin.top, y2: margin.top + innerH }));
  svg.appendChild(svgEl("line", { class: "axis-line", x1: margin.left, x2: margin.left + innerW, y1: margin.top + innerH, y2: margin.top + innerH }));

  var stackBottom = rows.map(function () { return 0; });
  WEALTH_SERIES.forEach(function (s) {
    var top = rows.map(function (r, idx) { return stackBottom[idx] + r[s.key]; });
    var d = "M" + sx(rows[0].year) + "," + sy(stackBottom[0]);
    rows.forEach(function (r, idx) { d += " L" + sx(r.year) + "," + sy(top[idx]); });
    for (var k = rows.length - 1; k >= 0; k--) { d += " L" + sx(rows[k].year) + "," + sy(stackBottom[k]); }
    d += " Z";
    var path = svgEl("path", { d: d, fill: s.color, class: "wealth-area", "data-series": s.key });
    var finalValue = rows[rows.length - 1][s.key];
    var tipRows = [["Value at year " + rows[rows.length - 1].year, fmtEUR0.format(finalValue)]];
    path.addEventListener("pointermove", function (e) { showTooltip(e, s.label, tipRows); });
    path.addEventListener("pointerleave", hideTooltip);
    svg.appendChild(path);
    stackBottom = top;

    var item = document.createElement("span");
    item.className = "legend-item";
    var sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = s.color;
    item.appendChild(sw);
    var lbl = document.createElement("span");
    lbl.textContent = s.label;
    item.appendChild(lbl);
    legendEl.appendChild(item);
  });

  container.appendChild(svg);
}

var WEALTH_METHODOLOGY_HTML =
  "<h3>The waterfall</h3>" +
  "<p>Every euro - starting capital and monthly savings alike - fills Livret A first (up to &euro;22,950), then LDDS (up to &euro;12,000), before anything else. Only the overflow beyond those caps splits between a preservation tier (Assurance Vie fonds euro, SCPI held as unit&eacute;s de compte inside an AV wrapper, CAT) and a growth tier (PEA, leveraged real estate, alternatives - gold+crypto), by the preservation/growth ratio in the allocation panel above (seeded from your risk tolerance: 70/30 conservative, 50/50 balanced, 25/75 aggressive). Within the growth tier, your STARTING capital splits three ways - PEA / real estate / alternatives, defaulting to 45%/35%/20% (hand-picked and illustrative - alternatives defaults to the smallest slice, reflecting its higher realized volatility) but adjustable via the growth-tier sliders; ongoing monthly savings allocated to the growth tier split two ways instead, PEA and alternatives only, in the same ratio as their two sliders above - real estate doesn't get ongoing contributions at all, see below. Dragging any allocation slider away from its risk-tolerance default switches the Risk tolerance selector to \"Customized\". PEA itself is also capped, at its real &euro;150,000 contribution limit - once hit, further growth-tier money doesn't vanish or sit idle, it falls back into the preservation tier instead, same as a real investor keeps saving through a different vehicle once PEA is maxed (alternatives has no such cap). This is a safety-first model, not a real financial plan for your specific situation.</p>" +
  "<h3>Real estate is modeled as a one-time purchase</h3>" +
  "<p>Monthly savings are too small to realistically drip into lumpy real-estate purchases, so leveraged real estate is sized once, from the risk-tolerance-driven growth-tier split of your STARTING capital only - a single mortgage amortization schedule, appreciating at the national median DVF price CAGR from year zero (see \"Growth assumption guard rails\" below for what happens when that figure isn't reliable yet). Ongoing monthly savings allocated to the growth tier go to PEA and alternatives instead (gold/crypto, unlike a house, can genuinely be bought a little at a time). Appreciation-only: no rental income is assumed, since DVF has sale prices, not rent data. Below a &euro;15,000 minimum down payment (apport), no leveraged purchase triggers at all - a real down payment that small doesn't buy any real French property - and that allocation goes to SCPI-in-AV instead (unlevered, but the closest \"real estate flavor\" exposure this model has).</p>" +
  "<h3>Tax</h3>" +
  "<p>Tax is applied once, at the end of your horizon, to each vehicle's realized gain - not annually - since French capital-gains tax is due on withdrawal, not on paper gains. Livret A and LDDS are always tax-free. AV/SCPI-in-AV use whichever is cheaper: the 30% flat tax (PFU) or your marginal bracket (TMI) plus 17.2% social charges; AV additionally gets an 8-year holding abatement (&euro;4,600 single / &euro;9,200 couple) and a reduced 24.7% rate on gains above it, assuming your cumulative AV premiums stay under &euro;150k. PEA is 0% income tax + 17.2% social charges after 5 years. Real estate is shown pre-tax (French real-estate capital-gains taper relief is its own complex schedule - a v2 item). <strong>Alternatives</strong> (gold+crypto) uses a flat 30% PFU on the gain, no holding-period discount - a simplification: real French crypto rules are broadly this already, but physical/paper gold has its own optional flat-rate-per-sale regime (taxe forfaitaire sur les m&eacute;taux pr&eacute;cieux) not modeled here. <strong>CAT is the one exception</strong>: its interest is taxed annually as it accrues, always at the flat 30% PFU (12.8% income tax + 17.2% social charges, no TMI-bareme option) - only the net interest compounds into the next year, unlike every other vehicle here. The \"Tax:\" figure shown above adds this cumulative annual CAT tax to the liquidation-time tax on AV/PEA/alternatives, for a complete lifetime total.</p>" +
  "<h3>Growth assumption guard rails</h3>" +
  "<p><strong>PEA</strong> uses the live equal-weighted average annualized return across the PEA tab's tracked ETFs only (diversified index trackers - CW8.PA world, PE500.PA S&amp;P500, and similar), not individual stocks and not a single ticker. Averaging in individual large-cap stocks was tried and rejected: with a short ingestion window their returns were both real and extraordinarily volatile (a couple of names moved 90-120%/year), which would misrepresent what a typical diversified PEA investor experiences. The ETF-only average is clamped to &plusmn;20%/year and falls back to a fixed, dated ~7%/year assumption if no ETF has enough trading-day history yet - a defensive measure against a short/unusual data window getting compounded 20-40 years forward, not a sign the live figure is distrusted once it's reliable. <strong>Real estate</strong> gets the same defensive treatment: DVF's multi-year price CAGR is sourced from the national median across d&eacute;partements with a reliable multi-year window (a dated illustrative fallback, ~3%/year, is used if none do yet), hard-capped at &plusmn;15%/year. <strong>Alternatives</strong> uses the live equal-weighted average across the Alternatives tab's <em>liquid</em> tickers only (GLD, BTC-USD, ETH-USD) - excluding the illiquid physical-gold proxy (GC=F), same reasoning as PEA's ETF-only average - clamped to the same &plusmn;20%/year and falling back to a fixed, illustrative ~6%/year if no liquid ticker has enough trading-day history yet. This clamp matters especially here: crypto's realized annualized return over a short ingestion window can be extreme, and compounding that uncapped over a 20-40 year horizon would be a bad extrapolation.</p>" +
  "<h3>Inflation comparison</h3>" +
  "<p>The \"If it only kept pace with inflation\" figure runs the same starting-capital-plus-annual-savings schedule your actual projection uses, but compounds every euro at the assumed inflation rate (adjustable in Tax, inflation &amp; risk, defaulting to the ECB's 2%/year target) instead of any vehicle's return - a fair, timing-matched floor, not just today's nominal total contributed. Your after-tax total is then compared against that floor: ahead of it means your investment grew your purchasing power, not just its nominal euro count; behind it means inflation ate more than your returns produced. \"In today's purchasing power\" restates your after-tax total in year-zero euros (divided by (1+inflation)^horizon), for the same reason.</p>" +
  "<h3>Market stress test</h3>" +
  "<p>Each configured crash year multiplies the balance already sitting in PEA, SCPI-in-AV, and Alternatives by (1 + drop%) at the start of that year - money contributed after the crash isn't marked down, only what was already invested. Livret A, LDDS, AV Fonds Euro, and CAT are capital-guaranteed in this model and never move. Real estate gets its own treatment: the crash rescales the property's price trajectory from that year onward, but the mortgage's outstanding balance is a fixed amortization schedule tied to the original loan - a market crash doesn't forgive what's owed - so a severe enough drop can legitimately show negative equity (being underwater on the mortgage), shown as-is rather than floored at zero. Multiple crash years compound: a -30% in year 5 and another -30% in year 15 is not the same as one -51%. This is still a single deterministic path per scenario, not a recovery-speed or mean-reversion model - growth resumes at the same assumed annual rate immediately after the shock, with no rebound modeled. \"Base case\" everywhere else on this tab (stats, risk-tolerance and inflation comparisons, the chart and table) is always the shock-free projection; configuring a stress test only affects this panel's own comparison.</p>" +
  "<h3>What's not modeled</h3>" +
  "<p>Monte Carlo bands (p10/p50/p90) are out of scope - this is a single deterministic path using published mean return/CAGR figures, not a distribution. Illustrative starting heuristic, not investment advice.</p>";

function initWealthSimulator(assumptions) {
  var emptyEl = document.getElementById("ws-empty");
  var contentEl = document.getElementById("ws-content");
  // assumptions.constants is what computation actually needs (Livret A/LDDS/AV/CAT/mortgage
  // rates, PFU/abatement thresholds); equities.etf_blended_default and
  // alternatives.liquid_blended_default are read too (see wealthComputeProjection) but aren't
  // required here - wealthClamp falls back to a fixed assumption if either is missing, so an
  // older export without those fields still works.
  if (!assumptions || !assumptions.constants || !assumptions.real_estate) {
    contentEl.style.display = "none";
    emptyEl.hidden = false;
    emptyEl.innerHTML = "No wealth-assumptions data published yet. Run <code>python scripts/export_wealth_assumptions.py</code> after dbt_transform has run at least once.";
    return;
  }

  var methodologyPanel = document.getElementById("ws-methodology-panel");
  methodologyPanel.innerHTML = WEALTH_METHODOLOGY_HTML;
  var methodologyBtn = document.getElementById("ws-methodology-toggle");
  methodologyBtn.addEventListener("click", function () {
    var expanded = methodologyBtn.getAttribute("aria-expanded") === "true";
    methodologyBtn.setAttribute("aria-expanded", String(!expanded));
    methodologyPanel.hidden = expanded;
    methodologyBtn.textContent = expanded ? "How is this calculated?" : "Hide methodology";
  });

  var controls = {
    capital: document.getElementById("ws-capital"),
    monthly: document.getElementById("ws-monthly"),
    horizon: document.getElementById("ws-horizon"),
    risk: document.getElementById("ws-risk"),
    tmi: document.getElementById("ws-tmi"),
    household: document.getElementById("ws-household"),
    inflation: document.getElementById("ws-inflation")
  };
  // Slider's markup ships a fixed value="2" (2%) as a reasonable static default before JS runs;
  // once assumptions are available, sync it to assumptions.constants.inflation.rate if present -
  // same "assumption drives the control's starting point" treatment risk tolerance's presets
  // get, and defensive against an older export that predates this field (falls back to the
  // markup default rather than throwing on a missing C.inflation).
  if (assumptions.constants.inflation && typeof assumptions.constants.inflation.rate === "number") {
    controls.inflation.value = String(Math.round(assumptions.constants.inflation.rate * 1000) / 10);
  }

  // The allocation editor: one slider for the top-level preservation/growth split, plus two
  // groups of relative weights (preservation tier's AV Fonds Euro/SCPI-in-AV/CAT, growth tier's
  // PEA/real estate/alternatives) that wealthNormalize turns into fractions summing to 1. Seeded
  // from WEALTH_TIER_SPLIT_DEFAULT/WEALTH_TIER3_SUBSPLIT_DEFAULT/WEALTH_TIER4_SUBSPLIT_DEFAULT
  // whenever a risk-tolerance preset is (re)selected - see applyAllocationPreset below.
  var allocControls = {
    growth: document.getElementById("ws-alloc-growth"),
    av: document.getElementById("ws-alloc-av"),
    scpi: document.getElementById("ws-alloc-scpi"),
    cat: document.getElementById("ws-alloc-cat"),
    pea: document.getElementById("ws-alloc-pea"),
    re: document.getElementById("ws-alloc-re"),
    alt: document.getElementById("ws-alloc-alt")
  };

  function readAllocation() {
    var growthPct = Number(allocControls.growth.value);
    var tier3Mix = wealthNormalize({
      avFondsEuro: Number(allocControls.av.value),
      scpiInAv: Number(allocControls.scpi.value),
      cat: Number(allocControls.cat.value)
    });
    var tier4Mix = wealthNormalize({
      pea: Number(allocControls.pea.value),
      realEstate: Number(allocControls.re.value),
      alternatives: Number(allocControls.alt.value)
    });
    // Ongoing (per-year) growth-tier contributions never touch real estate (see
    // wealthComputeProjection's comment) - drop it and renormalize PEA:alternatives over just
    // those two, so the ongoing ratio still tracks the user's growth-tier sliders.
    var tier4OngoingMix = wealthNormalize({ pea: tier4Mix.pea, alternatives: tier4Mix.alternatives });
    return {
      split: { preservation: (100 - growthPct) / 100, growth: growthPct / 100 },
      tier3Mix: tier3Mix,
      tier4Mix: tier4Mix,
      tier4OngoingMix: tier4OngoingMix
    };
  }

  // Sets every allocation slider back to a risk-tolerance preset's defaults - does NOT
  // re-render, callers do that themselves (so they can also update controls.risk.value first).
  function applyAllocationPreset(risk) {
    var preset = WEALTH_TIER_SPLIT_DEFAULT[risk];
    if (!preset) return;
    allocControls.growth.value = String(Math.round(preset.growth * 100));
    allocControls.av.value = String(Math.round(WEALTH_TIER3_SUBSPLIT_DEFAULT.avFondsEuro * 100));
    allocControls.scpi.value = String(Math.round(WEALTH_TIER3_SUBSPLIT_DEFAULT.scpiInAv * 100));
    allocControls.cat.value = String(Math.round(WEALTH_TIER3_SUBSPLIT_DEFAULT.cat * 100));
    allocControls.pea.value = String(Math.round(WEALTH_TIER4_SUBSPLIT_DEFAULT.pea * 100));
    allocControls.re.value = String(Math.round(WEALTH_TIER4_SUBSPLIT_DEFAULT.realEstate * 100));
    allocControls.alt.value = String(Math.round(WEALTH_TIER4_SUBSPLIT_DEFAULT.alternatives * 100));
  }

  // Tracks the last risk-tolerance preset explicitly chosen (not "custom"), so the "Reset
  // allocation" button has somewhere to reset back to even while "Customized" is selected.
  var lastPreset = controls.risk.value === "custom" ? "balanced" : controls.risk.value;

  // ---- Market stress test: dynamic list of { year, magnitude } crash events ----
  // shockRows is the source of truth (plain objects, not DOM) - renderShockRows() rebuilds the
  // row elements from it. Starts with one row defaulting to the final year (the scariest single
  // scenario: a crash right as you're about to liquidate), -30%.
  var WEALTH_SHOCK_MAGNITUDE_OPTIONS = [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6];
  var WEALTH_MAX_SHOCK_ROWS = 5;
  var shockRows = [{ year: Number(controls.horizon.value), magnitude: -0.3 }];
  // Only rebuild the row DOM when the horizon actually changes (re-clamping every row's year to
  // the new max) - NOT on every rerender(), since a shock row's own year/magnitude inputs also
  // trigger rerender() on every edit, and rebuilding the row DOM out from under an input the
  // user is actively typing into would drop focus/cursor position mid-edit.
  var lastHorizonForShocks = null;

  function renderShockRows() {
    var container = document.getElementById("ws-shocks-rows");
    container.innerHTML = "";
    var maxYear = Number(controls.horizon.value);
    shockRows.forEach(function (shock, idx) {
      var row = document.createElement("div");
      row.className = "sim-shock-row";

      var yearLabel = document.createElement("label");
      yearLabel.textContent = "Crash year";
      var yearInput = document.createElement("input");
      yearInput.type = "number";
      yearInput.min = "0";
      yearInput.max = String(maxYear);
      yearInput.step = "1";
      yearInput.value = String(shock.year);
      yearInput.addEventListener("input", function () {
        var v = Math.round(Number(yearInput.value));
        shock.year = isFinite(v) ? Math.max(0, Math.min(maxYear, v)) : 0;
        rerender();
      });
      yearLabel.appendChild(yearInput);

      var magLabel = document.createElement("label");
      magLabel.textContent = "Drop";
      var magSelect = document.createElement("select");
      WEALTH_SHOCK_MAGNITUDE_OPTIONS.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = String(m);
        opt.textContent = Math.round(-m * 100) + "%";
        if (m === shock.magnitude) opt.selected = true;
        magSelect.appendChild(opt);
      });
      magSelect.addEventListener("change", function () {
        shock.magnitude = Number(magSelect.value);
        rerender();
      });
      magLabel.appendChild(magSelect);

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "sim-shock-remove";
      removeBtn.setAttribute("aria-label", "Remove this crash year");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", function () {
        shockRows.splice(idx, 1);
        renderShockRows();
        rerender();
      });

      row.appendChild(yearLabel);
      row.appendChild(magLabel);
      row.appendChild(removeBtn);
      container.appendChild(row);
    });

    var addBtn = document.getElementById("ws-shocks-add");
    addBtn.disabled = shockRows.length >= WEALTH_MAX_SHOCK_ROWS;
    addBtn.textContent = addBtn.disabled ? "Crash year limit reached (" + WEALTH_MAX_SHOCK_ROWS + ")" : "+ Add crash year";
  }

  document.getElementById("ws-shocks-add").addEventListener("click", function () {
    if (shockRows.length >= WEALTH_MAX_SHOCK_ROWS) return;
    shockRows.push({ year: Number(controls.horizon.value), magnitude: -0.3 });
    renderShockRows();
    rerender();
  });

  // Column headers are annotated with each vehicle's assumed annual rate, so a reader doesn't
  // have to cross-reference the methodology panel to know what's driving a column's growth.
  // Livret A/LDDS/AV Fonds Euro/SCPI-in-AV/CAT come straight from assumptions.constants (fixed,
  // dated figures, same every render); PEA, Real estate, and Alternatives use wealthResolveGrowthAssumptions -
  // the exact same clamped/fallback figure wealthComputeProjection itself compounds with, not a
  // second copy that could drift out of sync. One caveat not shown in the header itself (see the
  // methodology panel's Tax section): CAT's column already reflects annual 30% PFU tax on its
  // interest, so its balance grows slower than the raw rate shown here would suggest on its own.
  var C = assumptions.constants;
  var growth = wealthResolveGrowthAssumptions(assumptions);
  function rateLabel(label, rate) {
    return label + " (" + fmtPct1Plain.format(rate) + ")";
  }
  var tableColumns = [
    { key: "year", label: "Year" },
    { key: "livretA", label: rateLabel("Livret A", C.livret_a.rate), format: function (v) { return fmtEUR0.format(v); } },
    { key: "ldds", label: rateLabel("LDDS", C.ldds.rate), format: function (v) { return fmtEUR0.format(v); } },
    { key: "avFondsEuro", label: rateLabel("AV Fonds Euro", C.av_fonds_euro.rate), format: function (v) { return fmtEUR0.format(v); } },
    { key: "scpiInAv", label: rateLabel("SCPI-in-AV", C.scpi_in_av.distribution_rate), format: function (v) { return fmtEUR0.format(v); } },
    { key: "cat", label: rateLabel("CAT", C.cat.rate), format: function (v) { return fmtEUR0.format(v); } },
    { key: "pea", label: rateLabel("PEA", growth.peaAnnualizedReturn), format: function (v) { return fmtEUR0.format(v); } },
    { key: "realEstateEquity", label: rateLabel("Real estate (equity)", growth.realEstateCagr), format: function (v) { return fmtEUR0.format(v); } },
    { key: "alternatives", label: rateLabel("Alternatives", growth.alternativesAnnualizedReturn), format: function (v) { return fmtEUR0.format(v); } },
    { key: "totalNetWorth", label: "Total (pre-tax)", format: function (v) { return fmtEUR0.format(v); } }
  ];

  var currentRows = [];
  var invalidateTable = wireTableToggle("ws-table-toggle", "ws-table-wrap", function () {
    renderTable(document.getElementById("ws-table-wrap"), currentRows, tableColumns);
  });

  function readParams() {
    var alloc = readAllocation();
    return {
      startingCapital: Number(controls.capital.value),
      monthlySavings: Number(controls.monthly.value),
      horizonYears: Number(controls.horizon.value),
      riskTolerance: controls.risk.value,
      tmiRate: Number(controls.tmi.value),
      household: controls.household.value,
      inflationRate: Number(controls.inflation.value) / 100,
      split: alloc.split,
      tier3Mix: alloc.tier3Mix,
      tier4Mix: alloc.tier4Mix,
      tier4OngoingMix: alloc.tier4OngoingMix
    };
  }

  var RISK_TOLERANCE_LABELS = { conservative: "Conservative", balanced: "Balanced", aggressive: "Aggressive" };

  function rerender() {
    document.getElementById("ws-capital-out").textContent = fmtEUR0.format(Number(controls.capital.value));
    document.getElementById("ws-monthly-out").textContent = fmtEUR0.format(Number(controls.monthly.value)) + "/mo";
    document.getElementById("ws-horizon-out").textContent = controls.horizon.value + " yr";

    // Only touches the shock-row DOM when the horizon slider actually moved (see shockRows'
    // declaration above for why) - re-clamps every configured crash year down to the new max
    // first, so a row can never point past the end of the (now-shorter) horizon.
    var horizonForShocks = Number(controls.horizon.value);
    if (horizonForShocks !== lastHorizonForShocks) {
      lastHorizonForShocks = horizonForShocks;
      shockRows.forEach(function (s) { s.year = Math.min(s.year, horizonForShocks); });
      renderShockRows();
    }

    var params = readParams();

    // Allocation sliders show the NORMALIZED percentage they resolve to, not the raw 0-100
    // weight underneath - e.g. if every growth-tier weight is dragged down evenly, each output
    // still reads its true (unchanged) share of the tier, not a shrinking raw number.
    document.getElementById("ws-alloc-preservation-out").textContent = fmtPct1Plain.format(params.split.preservation);
    document.getElementById("ws-alloc-growth-out").textContent = fmtPct1Plain.format(params.split.growth);
    document.getElementById("ws-alloc-av-out").textContent = fmtPct1Plain.format(params.tier3Mix.avFondsEuro);
    document.getElementById("ws-alloc-scpi-out").textContent = fmtPct1Plain.format(params.tier3Mix.scpiInAv);
    document.getElementById("ws-alloc-cat-out").textContent = fmtPct1Plain.format(params.tier3Mix.cat);
    document.getElementById("ws-alloc-pea-out").textContent = fmtPct1Plain.format(params.tier4Mix.pea);
    document.getElementById("ws-alloc-re-out").textContent = fmtPct1Plain.format(params.tier4Mix.realEstate);
    document.getElementById("ws-alloc-alt-out").textContent = fmtPct1Plain.format(params.tier4Mix.alternatives);
    document.getElementById("ws-inflation-out").textContent = fmtPct1Plain.format(params.inflationRate);
    document.getElementById("ws-inflation-compare-out").textContent = fmtPct1Plain.format(params.inflationRate);
    var result = wealthComputeProjection(params, assumptions);
    var finalRow = result.rows[result.rows.length - 1];
    var afterTax = wealthComputeAfterTaxLiquidation(finalRow, result.state, params, assumptions.constants);

    // Same capital/savings/horizon/tax settings AND the same preservation/growth sub-mix
    // (tier3Mix/tier4Mix/tier4OngoingMix) - only the top-level preservation/growth split
    // varies, so it's clear what the risk-tolerance dial itself is trading off, not a mix of
    // that and whatever the allocation sliders happen to be set to right now. When "Customized"
    // is selected, none of these three matches params.riskTolerance, so all three show as
    // alternatives (no tile is marked "current") - still a meaningful comparison.
    // The other two tiles' sub-line is a colored delta vs. the current selection (same
    // --diverging-pos/--diverging-neg tokens the bar charts already use for gains/losses) -
    // the absolute value itself stays neutral ink, since "higher net worth" isn't unambiguously
    // "better" here (this is a deterministic comparison, not a risk-adjusted one - more risk
    // tolerance isn't free, it's just not modeled as a downside in this single-path
    // projection - see the methodology panel).
    var compareEl = document.getElementById("ws-risk-compare");
    compareEl.innerHTML = "";
    var currentAfterTaxTotal = afterTax.total;
    Object.keys(RISK_TOLERANCE_LABELS).forEach(function (risk) {
      var isCurrent = risk === params.riskTolerance;
      var riskParams = Object.assign({}, params, { riskTolerance: risk, split: WEALTH_TIER_SPLIT_DEFAULT[risk] });
      var riskResult = isCurrent ? result : wealthComputeProjection(riskParams, assumptions);
      var riskFinalRow = riskResult.rows[riskResult.rows.length - 1];
      var riskAfterTax = isCurrent ? afterTax : wealthComputeAfterTaxLiquidation(riskFinalRow, riskResult.state, riskParams, assumptions.constants);
      var delta = riskAfterTax.total - currentAfterTaxTotal;
      addStatTile(
        compareEl,
        RISK_TOLERANCE_LABELS[risk] + (isCurrent ? " (current)" : ""),
        fmtEUR0.format(riskAfterTax.total),
        isCurrent ? "Pre-tax: " + fmtEUR0.format(riskFinalRow.totalNetWorth) : fmtEUR0Signed.format(delta) + " vs. current",
        isCurrent,
        isCurrent ? null : (delta >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)")
      );
    });

    // Answers "did this investment actually beat inflation, or just grow in nominal terms?"
    // wealthComputeInflationBenchmark runs the SAME contribution schedule (starting capital +
    // annual savings) forward at the assumed inflation rate instead of any vehicle's return -
    // a fair, timing-matched floor, not just today's nominal total contributed. Tile 1 is your
    // actual after-tax result (neutral ink, same "current" treatment as the risk-tolerance row);
    // tile 2 is that inflation-only floor (also neutral - it's a benchmark, not a choice you
    // made); tile 3 carries the verdict as a signed, colored delta between the two - positive
    // and green means you beat inflation, negative and red means inflation beat you.
    var inflationEl = document.getElementById("ws-inflation-compare");
    inflationEl.innerHTML = "";
    var inflationBenchmark = wealthComputeInflationBenchmark(params);
    var realAfterTax = afterTax.total / Math.pow(1 + params.inflationRate, params.horizonYears);
    var gainVsInflation = afterTax.total - inflationBenchmark;
    addStatTile(inflationEl, "Your portfolio (after-tax)", fmtEUR0.format(afterTax.total), "Pre-tax: " + fmtEUR0.format(finalRow.totalNetWorth), true, null);
    addStatTile(inflationEl, "If it only kept pace with inflation", fmtEUR0.format(inflationBenchmark), "Same contributions, no investment growth", false, null);
    addStatTile(
      inflationEl,
      gainVsInflation >= 0 ? "Ahead of inflation by" : "Behind inflation by",
      fmtEUR0Signed.format(gainVsInflation),
      "In today's purchasing power: " + fmtEUR0.format(realAfterTax),
      false,
      null,
      gainVsInflation >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)"
    );

    // Market stress test: "Base case" is the same result already computed above (no shocks -
    // every other tile/chart/table on this tab is always shock-free, so configuring a crash
    // here never silently changes the rest of the page). "Your scenario" re-runs the exact same
    // params with shockRows attached, isolated to this one comparison. With no rows configured,
    // there's nothing to compare yet - say so instead of showing a redundant second "base case"
    // tile.
    var shocksEl = document.getElementById("ws-shocks-compare");
    shocksEl.innerHTML = "";
    addStatTile(shocksEl, "Base case (after-tax)", fmtEUR0.format(afterTax.total), "Pre-tax: " + fmtEUR0.format(finalRow.totalNetWorth), true, null);
    if (shockRows.length === 0) {
      addStatTile(shocksEl, "Your scenario", "—", "Add a crash year above to compare", false, null);
    } else {
      var shocks = shockRows.map(function (s) { return { year: s.year, magnitude: s.magnitude }; });
      var shockedParams = Object.assign({}, params, { shocks: shocks });
      var shockedResult = wealthComputeProjection(shockedParams, assumptions);
      var shockedFinalRow = shockedResult.rows[shockedResult.rows.length - 1];
      var shockedAfterTax = wealthComputeAfterTaxLiquidation(shockedFinalRow, shockedResult.state, shockedParams, assumptions.constants);
      var shockDelta = shockedAfterTax.total - afterTax.total;
      addStatTile(
        shocksEl,
        "Your scenario (after-tax)",
        fmtEUR0.format(shockedAfterTax.total),
        fmtEUR0Signed.format(shockDelta) + " vs. base case",
        false,
        null,
        shockDelta >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)"
      );
    }

    // Total tax paid over the whole horizon = tax due at liquidation (AV/PEA) + CAT's tax,
    // already paid annually as it accrued (see wealthComputeProjection). afterTax.total is
    // still the correct final after-tax figure either way - CAT's tax is already baked into
    // its balance, not double-counted here, this is just for a complete "Tax:" display.
    var totalTaxOverHorizon = afterTax.taxPaid + result.catTaxPaidCumulative;
    var totalContributed = params.startingCapital + params.monthlySavings * 12 * params.horizonYears;
    var vsContributed = afterTax.total - totalContributed;

    var statsEl = document.getElementById("ws-stats");
    statsEl.innerHTML = "";
    addStatTile(statsEl, "Net worth (year " + params.horizonYears + ")", fmtEUR0.format(finalRow.totalNetWorth), "CAT taxed annually as accrued; other vehicles' tax is due at liquidation, below");
    addStatTile(statsEl, "After-tax net worth if liquidated", fmtEUR0.format(afterTax.total), [
      { text: "Total tax over the horizon: " + fmtEUR0.format(totalTaxOverHorizon) },
      {
        text: fmtEUR0Signed.format(vsContributed) + " vs. total contributed",
        color: vsContributed >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)"
      }
    ]);
    addStatTile(statsEl, "Total contributed", fmtEUR0.format(totalContributed), null);

    currentRows = result.rows;
    renderWealthChart(document.getElementById("ws-chart"), document.getElementById("ws-legend"), result.rows);
    var wrap = document.getElementById("ws-table-wrap");
    if (!wrap.hidden) { renderTable(wrap, currentRows, tableColumns); }
    invalidateTable();
  }

  // Picking a risk-tolerance preset resets every allocation slider to that preset's defaults
  // (overwriting any prior customization); picking "Customized" directly is a no-op on the
  // sliders, it just keeps whatever they're currently set to.
  controls.risk.addEventListener("input", function () {
    if (controls.risk.value !== "custom") {
      lastPreset = controls.risk.value;
      applyAllocationPreset(controls.risk.value);
    }
    rerender();
  });
  Object.keys(controls).forEach(function (k) {
    if (k === "risk") return;
    controls[k].addEventListener("input", rerender);
  });

  // Dragging ANY allocation slider is what "customizing" means here - flip risk tolerance to
  // "Customized" (unless it's already there) so the select never silently disagrees with what
  // the sliders actually show.
  Object.keys(allocControls).forEach(function (k) {
    allocControls[k].addEventListener("input", function () {
      if (controls.risk.value !== "custom") { controls.risk.value = "custom"; }
      rerender();
    });
  });

  document.getElementById("ws-alloc-reset").addEventListener("click", function () {
    controls.risk.value = lastPreset;
    applyAllocationPreset(lastPreset);
    rerender();
  });

  rerender();
}
