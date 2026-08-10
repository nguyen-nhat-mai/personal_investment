"use strict";
// PEA tab. Depends on utils.js and charts.js - must load after both.

// Sort helper: treats a real 0% return correctly (unlike `value || fallback`, which
// would coerce 0 to the fallback since 0 is falsy) and sorts missing values last. Sorts by
// annualized_return, not period_return_pct - the latter isn't comparable across tickers with
// different amounts of ingested history (a ticker with 2 years of data and one with 5 days
// aren't on the same footing), and it's exactly what let GLE.PA briefly show +327% (see
// equity_performance_summary.sql's first_last_price CTE for the underlying fix too).
function retVal(d) {
  return typeof d.annualized_return === "number" ? d.annualized_return : -Infinity;
}

function initPortfolio(data) {
  var emptyEl = document.getElementById("pf-empty");
  var contentEl = document.getElementById("pf-content");
  if (!data.length) {
    contentEl.style.display = "none";
    emptyEl.hidden = false;
    emptyEl.innerHTML = "No PEA data published yet. Run <code>python scripts/export_marts.py</code> after equities_ingest and dbt_transform have run at least once.";
    return;
  }

  var methodologyPanel = document.getElementById("pf-methodology-panel");
  methodologyPanel.innerHTML =
    "<h3>Return, volatility &amp; drawdown</h3>" +
    "<p><strong>Period return</strong> is the median of the last 5 trading days' adjusted-close price over the median of the first 5, minus one, over whatever history has been ingested so far for that ticker - a median of 5, not a single point-to-point comparison, so one glitchy data point on the literal first or last ingested day can't swing the whole figure on its own. <strong>Annualized return</strong> geometrically annualizes that same robust figure - power(last_price / first_price, 252 / trading_days) - 1 - NOT an arithmetic-mean-based shortcut: an earlier version of this formula raised the arithmetic mean of daily returns to the 252nd power, which is mathematically wrong (arithmetic mean is always &ge; geometric mean, more so for volatile stocks) and produced real, seriously distorted figures - a volatile bank stock briefly showed 121%/year here when the true geometrically-annualized figure for the same prices was ~25-30%/year. <strong>Annualized volatility</strong> is the standard deviation of daily returns scaled by &radic;252 (that formula was always correct - time-scaling a standard deviation is the textbook approach, the flaw was specific to annualizing a return via an arithmetic-mean proxy). <strong>Max drawdown</strong> is the worst peak-to-trough decline seen so far. All of these, plus Sharpe below, use adjusted close (<code>adj_close</code>) throughout, not raw close - dividends and splits are already priced in, not double-counted separately.</p>" +
    "<h3>The 60-trading-day gate</h3>" +
    "<p>Annualized return/volatility/drawdown/Sharpe/vs.-benchmark are all null until a ticker has 60+ trading days of ingested history. Short-history extrapolation fails in <em>both</em> directions: a noisy few-day average return can produce an absurd annualized figure, while max drawdown does the opposite - a ticker that's only lived through a few good days looks like a falsely-flattering 0%-risk asset. Both get \"&ndash;\" instead of a number, not a fabricated one.</p>" +
    "<h3>Sharpe ratio</h3>" +
    "<p>(annualized return &minus; risk_free_rate_pct) / annualized volatility. risk_free_rate_pct is a single dated hand-set constant (an illustrative French OAT baseline, ~2.5%) - not a real yield curve or a BigQuery-sourced figure, see <code>dbt_project.yml</code>.</p>" +
    "<h3>Vs. CW8.PA</h3>" +
    "<p>This ticker's annualized return minus the benchmark's (Amundi MSCI World ETF), both recomputed over their shared date-aligned window - not each ticker's own independently-ingested first/last date. That distinction matters here specifically: this watchlist spans 5 exchanges (Paris/Amsterdam/Frankfurt/Copenhagen/Madrid) with different public holidays, so two tickers' \"own\" date ranges can genuinely differ by a day or more, and subtracting two annualized returns computed over two different periods isn't a real excess return. Simple excess return, not a Beta-adjusted CAPM alpha.</p>" +
    "<h3>Country</h3>" +
    "<p>Derived from each ticker's ISIN prefix (the national numbering agency, i.e. legal domicile) - not hand-typed. That distinction caught 5 real mistakes in this watchlist: ArcelorMittal and Eurofins Scientific are Luxembourg-domiciled, Airbus/Stellantis/STMicroelectronics are Netherlands-domiciled, despite all five being long-standing CAC 40 \"French\" constituents by reputation - Euronext's own CAC 40 factsheet lists all five as \"Country: France\" on what's likely a headquarters/operations basis, not a legal-domicile one. Both are legitimate; this column picks the one that actually matters for real PEA eligibility rules. ISINs for 10 of 50 tickers were live-verified; the rest are best-effort - see <code>dbt/seeds/_seeds.yml</code>.</p>" +
    "<h3>Dividends</h3>" +
    "<p>Summed over the ingested history (not annualized). <strong>Dividend yield</strong> is that sum divided by the last observed price - a trailing yield, not a forward-looking one.</p>";
  var methodologyBtn = document.getElementById("pf-methodology-toggle");
  methodologyBtn.addEventListener("click", function () {
    var expanded = methodologyBtn.getAttribute("aria-expanded") === "true";
    methodologyBtn.setAttribute("aria-expanded", String(!expanded));
    methodologyPanel.hidden = expanded;
    methodologyBtn.textContent = expanded ? "How is this calculated?" : "Hide methodology";
  });

  var typeSelect = document.getElementById("pf-filter-type");
  var legendState = { stock: true, etf: true };

  var legendEl = document.getElementById("pf-legend");
  [["stock", "Stock", "var(--series-1)"], ["etf", "ETF", "var(--series-2)"]].forEach(function (g) {
    var btn = document.createElement("button");
    btn.className = "legend-item";
    btn.setAttribute("aria-pressed", "true");
    var sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = g[2];
    btn.appendChild(sw);
    var lbl = document.createElement("span");
    lbl.textContent = g[1];
    btn.appendChild(lbl);
    btn.addEventListener("click", function () {
      legendState[g[0]] = !legendState[g[0]];
      btn.setAttribute("aria-pressed", String(legendState[g[0]]));
      applyFilters();
    });
    legendEl.appendChild(btn);
  });

  // Bar chart ranking metric - a single-select toggle (only one active at a time), reusing
  // .legend-item's visual style (including the aria-pressed="false" dim-opacity rule) even
  // though semantically this isn't a multi-select filter like the Stock/ETF legend above.
  // Scoped to just this chart: the table and "Best performer"/"Avg." stats always stay ranked
  // by annualized_return regardless of this toggle.
  var BAR_METRICS = {
    annualized_return: {
      title: "Annualized return by ticker",
      valueKey: "annualized_return",
      valueFormatter: function (v) { return fmtPct1.format(v); }
    },
    sharpe_ratio: {
      title: "Sharpe ratio by ticker",
      valueKey: "sharpe_ratio",
      valueFormatter: function (v) { return fmtScore.format(v); }
    }
  };
  var barMetric = "annualized_return";
  var barMetricButtons = {
    annualized_return: document.getElementById("pf-bar-metric-return"),
    sharpe_ratio: document.getElementById("pf-bar-metric-sharpe")
  };
  Object.keys(barMetricButtons).forEach(function (key) {
    barMetricButtons[key].addEventListener("click", function () {
      if (barMetric === key) return;
      barMetric = key;
      Object.keys(barMetricButtons).forEach(function (k) { barMetricButtons[k].setAttribute("aria-pressed", String(k === key)); });
      render(currentFilteredData);
    });
  });

  var columns = [
    { key: "ticker", label: "Ticker" },
    { key: "name", label: "Name" },
    { key: "asset_type", label: "Type" },
    { key: "country", label: "Country", format: function (v) { return v || "–"; } },
    { key: "first_date", label: "Since", format: function (v) { return v || "–"; } },
    { key: "last_date", label: "Until", format: function (v) { return v || "–"; } },
    { key: "annualized_return", label: "Annualized return", format: function (v) { return v == null ? "–" : fmtPct1.format(v); } },
    { key: "annualized_volatility", label: "Volatility", format: function (v) { return v == null ? "–" : fmtPct1Plain.format(v); } },
    { key: "max_drawdown_pct", label: "Max drawdown", format: function (v) { return v == null ? "–" : fmtPct1.format(v); } },
    { key: "sharpe_ratio", label: "Sharpe", format: function (v) { return v == null ? "–" : fmtScore.format(v); } },
    { key: "relative_performance_vs_benchmark", label: "Vs. CW8.PA", format: function (v) { return v == null ? "–" : fmtPct1.format(v); } },
    { key: "total_dividends", label: "Dividends", format: function (v) { return v == null ? "–" : fmtEUR2.format(v); } },
    { key: "dividend_yield_pct", label: "Div. yield", format: function (v) { return v == null ? "–" : fmtPct1Plain.format(v); } }
  ];

  var currentFilteredData = data;
  var invalidateTable = wireTableToggle("pf-table-toggle", "pf-table-wrap", function () {
    renderTable(document.getElementById("pf-table-wrap"), currentFilteredData, columns);
  });

  function applyFilters() {
    var type = typeSelect.value;
    var filtered = data.filter(function (d) {
      if (type && d.asset_type !== type) return false;
      if (d.asset_type === "stock" && !legendState.stock) return false;
      if (d.asset_type === "etf" && !legendState.etf) return false;
      return true;
    });
    currentFilteredData = filtered.slice().sort(function (a, b) { return retVal(b) - retVal(a); });
    render(currentFilteredData);
    var wrap = document.getElementById("pf-table-wrap");
    if (!wrap.hidden) { renderTable(wrap, currentFilteredData, columns); }
    invalidateTable();
  }

  function render(filtered) {
    var statsEl = document.getElementById("pf-stats");
    statsEl.innerHTML = "";
    var best = filtered.filter(function (d) { return d.annualized_return != null; }).sort(function (a, b) { return b.annualized_return - a.annualized_return; })[0];
    // Only average tickers that actually have a value - null means "not enough trading-day
    // history yet" (see min_trading_days_for_return), not zero return/volatility. Coalescing
    // null to 0 here would silently average in every not-yet-reliable ticker as if it were a
    // real 0%, understating the true figure (in the extreme - no ticker qualifying yet -
    // showing a misleading "0%" instead of "not enough data").
    var retValues = filtered.map(function (d) { return d.annualized_return; }).filter(function (v) { return v != null; });
    var avgReturn = retValues.length ? retValues.reduce(function (s, v) { return s + v; }, 0) / retValues.length : null;
    var volValues = filtered.map(function (d) { return d.annualized_volatility; }).filter(function (v) { return v != null; });
    var avgVol = volValues.length ? volValues.reduce(function (s, v) { return s + v; }, 0) / volValues.length : null;
    var bestSharpe = filtered.filter(function (d) { return d.sharpe_ratio != null; }).sort(function (a, b) { return b.sharpe_ratio - a.sharpe_ratio; })[0];
    var stockCount = filtered.filter(function (d) { return d.asset_type === "stock"; }).length;
    var etfCount = filtered.filter(function (d) { return d.asset_type === "etf"; }).length;
    addStatTile(statsEl, "Tickers tracked", fmtInt.format(filtered.length), stockCount + " stocks, " + etfCount + " ETFs");
    addStatTile(statsEl, "Best performer (annualized)", best ? best.ticker : "–", best ? fmtPct1.format(best.annualized_return) : "Needs 60+ trading days of history");
    // Shown next to "Best performer" deliberately - a single extreme ticker being the "best"
    // doesn't say much about the watchlist as a whole; the average makes it visible when a
    // headline figure is an outlier rather than representative (e.g. one stock at +327% next
    // to a watchlist averaging a much more modest figure).
    addStatTile(statsEl, "Avg. annualized return", avgReturn != null ? fmtPct1.format(avgReturn) : "–", null);
    addStatTile(statsEl, "Avg. annualized volatility", avgVol != null ? fmtPct1Plain.format(avgVol) : "–", null);
    addStatTile(statsEl, "Best risk-adjusted (Sharpe)", bestSharpe ? bestSharpe.ticker : "–", bestSharpe ? "Sharpe " + fmtScore.format(bestSharpe.sharpe_ratio) : "Needs 60+ trading days of history");

    var metricCfg = BAR_METRICS[barMetric];
    document.getElementById("pf-bar-title").textContent = metricCfg.title;
    var barItems = filtered.filter(function (d) { return d[metricCfg.valueKey] != null; })
      .sort(function (a, b) { return b[metricCfg.valueKey] - a[metricCfg.valueKey]; })
      .map(function (d) {
        return {
          label: d.ticker,
          value: d[metricCfg.valueKey],
          extra: [["Name", d.name || d.ticker], ["Type", d.asset_type || "–"], ["Trading days", fmtInt.format(d.trading_days)]]
        };
      });
    renderDivergingBarChart(document.getElementById("pf-bar"), barItems, { valueFormatter: metricCfg.valueFormatter });

    renderScatterChart(document.getElementById("pf-scatter"), filtered.filter(function (d) { return d.annualized_volatility != null && d.annualized_return != null; }).map(function (d) {
      return {
        x: d.annualized_volatility,
        y: d.annualized_return,
        label: d.ticker,
        color: d.asset_type === "etf" ? "var(--series-2)" : "var(--series-1)",
        group: d.asset_type,
        extra: [["Name", d.name || d.ticker], ["Annualized return", fmtPct1.format(d.annualized_return)], ["Annualized volatility", fmtPct1Plain.format(d.annualized_volatility)]]
      };
    }), {
      width: 900, height: 340,
      xTickFormatter: function (v) { return fmtPct1Plain.format(v); },
      yTickFormatter: function (v) { return fmtPct1.format(v); },
      ariaLabel: "Annualized volatility versus annualized return, one dot per ticker",
      emptyMessage: "No ticker has 60+ trading days of history yet - see \"How is this calculated?\"."
    });
  }

  typeSelect.addEventListener("change", applyFilters);
  applyFilters();
}
