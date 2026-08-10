"use strict";
// Wealth simulator tab. Depends on utils.js and charts.js (fmt*, svgEl, addStatTile,
// wireTableToggle, renderTable) - must load after both.

// Every euro fills Livret A then LDDS first (safety-first, unconditional); risk tolerance
// only governs how the OVERFLOW beyond those caps splits between the preservation tier
// (Assurance Vie fonds euro / SCPI-in-AV / CAT) and the growth tier (PEA / leveraged real
// estate). See the tab's own methodology panel for the full explanation.
var WEALTH_TIER_SPLIT = {
  conservative: { preservation: 0.70, growth: 0.30 },
  balanced:     { preservation: 0.50, growth: 0.50 },
  aggressive:   { preservation: 0.25, growth: 0.75 }
};
// v1 simplification: within the growth tier, PEA/leveraged real estate/alternatives is a fixed
// 3-way split regardless of risk tolerance - only the preservation/growth ratio itself is
// risk-driven, to avoid an under-specified second "how aggressive is the mix" axis. Weights are
// hand-picked and illustrative (same treatment the original 50/50 PEA/real-estate split got),
// not derived from anything - alternatives gets the smallest slice, reflecting that it's the
// newest, most speculative-in-practice leg of the three (gold+crypto's realized volatility is
// materially higher than a diversified PEA ETF blend or national median real-estate CAGR).
var WEALTH_TIER4_SUBSPLIT = { pea: 0.45, realEstate: 0.35, alternatives: 0.20 };

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
function wealthBuildRealEstatePosition(equity0, mortgageCfg, priceCagr) {
  if (!(equity0 > 0)) return null;
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

  return {
    propertyPrice0: propertyPrice0,
    principal: principal,
    equityAtYear: function (year) {
      var value = propertyPrice0 * Math.pow(1 + priceCagr, year);
      return Math.max(0, value - outstandingBalance(year * 12));
    }
  };
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
// fractional houses, unlike gold/crypto which can genuinely be dollar-cost-averaged into).
// Roughly matches WEALTH_TIER4_SUBSPLIT's pea:alternatives ratio (0.45:0.20), rounded to clean
// numbers for the ongoing-contribution case specifically.
var WEALTH_TIER4_ONGOING_SUBSPLIT = { pea: 0.7, alternatives: 0.3 };
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
  var split = WEALTH_TIER_SPLIT[params.riskTolerance];

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
  wealthDepositInto(state.avFondsEuro, init.tier3 / 3, Infinity);
  wealthDepositInto(state.scpiInAv, init.tier3 / 3, Infinity);
  wealthDepositInto(state.cat, init.tier3 / 3, Infinity);
  // PEA's EUR150k contribution cap can bind even on the initial deposit for a large starting
  // capital - route any overflow into the (uncapped) preservation tier rather than losing it,
  // same treatment the ongoing per-year contribution loop below uses.
  var peaOverflowInit = wealthDepositInto(state.pea, init.tier4 * WEALTH_TIER4_SUBSPLIT.pea, C.pea.cap);
  wealthDepositInto(state.avFondsEuro, peaOverflowInit / 3, Infinity);
  wealthDepositInto(state.scpiInAv, peaOverflowInit / 3, Infinity);
  wealthDepositInto(state.cat, peaOverflowInit / 3, Infinity);
  // No contribution cap on alternatives (unlike PEA's real EUR150k one), so no overflow
  // handling needed here.
  wealthDepositInto(state.alternatives, init.tier4 * WEALTH_TIER4_SUBSPLIT.alternatives, Infinity);

  // Below the minimum realistic down payment, no leveraged property purchase triggers - route
  // that portion to SCPI-in-AV instead (not the general 3-way preservation split: this money
  // was earmarked for "real estate flavor" exposure specifically, and SCPI-in-AV is the closest
  // unlevered equivalent already in this model).
  var reEquityCandidate = init.tier4 * WEALTH_TIER4_SUBSPLIT.realEstate;
  var realEstate = null;
  if (reEquityCandidate >= WEALTH_MIN_REAL_ESTATE_DOWN_PAYMENT) {
    realEstate = wealthBuildRealEstatePosition(reEquityCandidate, C.mortgage, reCagr);
  } else {
    wealthDepositInto(state.scpiInAv, reEquityCandidate, Infinity);
  }

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
    wealthDepositInto(state.avFondsEuro, yr.tier3 / 3, Infinity);
    wealthDepositInto(state.scpiInAv, yr.tier3 / 3, Infinity);
    wealthDepositInto(state.cat, yr.tier3 / 3, Infinity);
    // Ongoing tier-4 splits between PEA and alternatives (see WEALTH_TIER4_ONGOING_SUBSPLIT -
    // real estate doesn't get ongoing contributions), until PEA's EUR150k contribution cap is
    // hit; overflow past that falls back to the (uncapped) preservation tier instead of
    // vanishing - a real investor keeps saving through a different vehicle once PEA is maxed,
    // not stops saving. Alternatives has no such cap, so no overflow handling needed there.
    var peaOverflow = wealthDepositInto(state.pea, yr.tier4 * WEALTH_TIER4_ONGOING_SUBSPLIT.pea, C.pea.cap);
    wealthDepositInto(state.avFondsEuro, peaOverflow / 3, Infinity);
    wealthDepositInto(state.scpiInAv, peaOverflow / 3, Infinity);
    wealthDepositInto(state.cat, peaOverflow / 3, Infinity);
    wealthDepositInto(state.alternatives, yr.tier4 * WEALTH_TIER4_ONGOING_SUBSPLIT.alternatives, Infinity);

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
  "<p>Every euro - starting capital and monthly savings alike - fills Livret A first (up to &euro;22,950), then LDDS (up to &euro;12,000), before anything else. Only the overflow beyond those caps splits between a preservation tier (Assurance Vie fonds euro, SCPI held as unit&eacute;s de compte inside an AV wrapper, CAT) and a growth tier (PEA, leveraged real estate, alternatives - gold+crypto), by your risk tolerance slider. Within the growth tier, your STARTING capital splits three ways (PEA 45% / real estate 35% / alternatives 20%, hand-picked and illustrative - alternatives gets the smallest slice, reflecting its higher realized volatility); ongoing monthly savings allocated to the growth tier split two ways instead, PEA and alternatives only (roughly 70%/30%) - real estate doesn't get ongoing contributions at all, see below. PEA itself is also capped, at its real &euro;150,000 contribution limit - once hit, further growth-tier money doesn't vanish or sit idle, it falls back into the preservation tier instead, same as a real investor keeps saving through a different vehicle once PEA is maxed (alternatives has no such cap). This is a safety-first model, not a real financial plan for your specific situation.</p>" +
  "<h3>Real estate is modeled as a one-time purchase</h3>" +
  "<p>Monthly savings are too small to realistically drip into lumpy real-estate purchases, so leveraged real estate is sized once, from the risk-tolerance-driven growth-tier split of your STARTING capital only - a single mortgage amortization schedule, appreciating at the national median DVF price CAGR from year zero (see \"Growth assumption guard rails\" below for what happens when that figure isn't reliable yet). Ongoing monthly savings allocated to the growth tier go to PEA and alternatives instead (gold/crypto, unlike a house, can genuinely be bought a little at a time). Appreciation-only: no rental income is assumed, since DVF has sale prices, not rent data. Below a &euro;15,000 minimum down payment (apport), no leveraged purchase triggers at all - a real down payment that small doesn't buy any real French property - and that allocation goes to SCPI-in-AV instead (unlevered, but the closest \"real estate flavor\" exposure this model has).</p>" +
  "<h3>Tax</h3>" +
  "<p>Tax is applied once, at the end of your horizon, to each vehicle's realized gain - not annually - since French capital-gains tax is due on withdrawal, not on paper gains. Livret A and LDDS are always tax-free. AV/SCPI-in-AV use whichever is cheaper: the 30% flat tax (PFU) or your marginal bracket (TMI) plus 17.2% social charges; AV additionally gets an 8-year holding abatement (&euro;4,600 single / &euro;9,200 couple) and a reduced 24.7% rate on gains above it, assuming your cumulative AV premiums stay under &euro;150k. PEA is 0% income tax + 17.2% social charges after 5 years. Real estate is shown pre-tax (French real-estate capital-gains taper relief is its own complex schedule - a v2 item). <strong>Alternatives</strong> (gold+crypto) uses a flat 30% PFU on the gain, no holding-period discount - a simplification: real French crypto rules are broadly this already, but physical/paper gold has its own optional flat-rate-per-sale regime (taxe forfaitaire sur les m&eacute;taux pr&eacute;cieux) not modeled here. <strong>CAT is the one exception</strong>: its interest is taxed annually as it accrues, always at the flat 30% PFU (12.8% income tax + 17.2% social charges, no TMI-bareme option) - only the net interest compounds into the next year, unlike every other vehicle here. The \"Tax:\" figure shown above adds this cumulative annual CAT tax to the liquidation-time tax on AV/PEA/alternatives, for a complete lifetime total.</p>" +
  "<h3>Growth assumption guard rails</h3>" +
  "<p><strong>PEA</strong> uses the live equal-weighted average annualized return across the PEA tab's tracked ETFs only (diversified index trackers - CW8.PA world, PE500.PA S&amp;P500, and similar), not individual stocks and not a single ticker. Averaging in individual large-cap stocks was tried and rejected: with a short ingestion window their returns were both real and extraordinarily volatile (a couple of names moved 90-120%/year), which would misrepresent what a typical diversified PEA investor experiences. The ETF-only average is clamped to &plusmn;20%/year and falls back to a fixed, dated ~7%/year assumption if no ETF has enough trading-day history yet - a defensive measure against a short/unusual data window getting compounded 20-40 years forward, not a sign the live figure is distrusted once it's reliable. <strong>Real estate</strong> gets the same defensive treatment: DVF's multi-year price CAGR is sourced from the national median across d&eacute;partements with a reliable multi-year window (a dated illustrative fallback, ~3%/year, is used if none do yet), hard-capped at &plusmn;15%/year. <strong>Alternatives</strong> uses the live equal-weighted average across the Alternatives tab's <em>liquid</em> tickers only (GLD, BTC-USD, ETH-USD) - excluding the illiquid physical-gold proxy (GC=F), same reasoning as PEA's ETF-only average - clamped to the same &plusmn;20%/year and falling back to a fixed, illustrative ~6%/year if no liquid ticker has enough trading-day history yet. This clamp matters especially here: crypto's realized annualized return over a short ingestion window can be extreme, and compounding that uncapped over a 20-40 year horizon would be a bad extrapolation.</p>" +
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
    household: document.getElementById("ws-household")
  };

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
    return {
      startingCapital: Number(controls.capital.value),
      monthlySavings: Number(controls.monthly.value),
      horizonYears: Number(controls.horizon.value),
      riskTolerance: controls.risk.value,
      tmiRate: Number(controls.tmi.value),
      household: controls.household.value
    };
  }

  var RISK_TOLERANCE_LABELS = { conservative: "Conservative", balanced: "Balanced", aggressive: "Aggressive" };

  function rerender() {
    document.getElementById("ws-capital-out").textContent = fmtEUR0.format(Number(controls.capital.value));
    document.getElementById("ws-monthly-out").textContent = fmtEUR0.format(Number(controls.monthly.value)) + "/mo";
    document.getElementById("ws-horizon-out").textContent = controls.horizon.value + " yr";

    var params = readParams();
    var result = wealthComputeProjection(params, assumptions);
    var finalRow = result.rows[result.rows.length - 1];
    var afterTax = wealthComputeAfterTaxLiquidation(finalRow, result.state, params, assumptions.constants);

    // Same capital/savings/horizon/tax settings, only riskTolerance varies - so it's clear
    // what the slider is actually trading off, not just what the current setting produces.
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
      var riskParams = Object.assign({}, params, { riskTolerance: risk });
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

  Object.keys(controls).forEach(function (k) { controls[k].addEventListener("input", rerender); });
  rerender();
}
