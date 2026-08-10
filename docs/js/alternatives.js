"use strict";
// Alternatives tab (gold + crypto watchlist). Depends on utils.js and charts.js - must load
// after both. Structurally a trimmed sibling of portfolio.js (same scatter/bar/table shape),
// minus the PEA-only concepts that don't apply here: no benchmark comparison (no single
// coherent benchmark across gold and crypto), no country/ISIN, no dividends (none of these 4
// instruments pays one).

// Same sortVal treatment as portfolio.js's - see that file's comment for why annualized_return/
// sharpe_ratio (not period_return_pct) is the right ranking basis.
function altSortVal(d, metricCfg) {
  var v = d[metricCfg.valueKey];
  return typeof v === "number" ? v : -Infinity;
}

var ALT_INSTRUMENT_LABELS = { physical_gold: "Physical gold", paper_gold: "Paper gold", crypto: "Crypto" };
var ALT_INSTRUMENT_COLORS = { physical_gold: "var(--series-1)", paper_gold: "var(--series-2)", crypto: "var(--series-3)" };
// "Illiquid to hold", not bare "Illiquid" - this describes how easily YOU could convert the
// underlying holding to cash (a gold bar takes a dealer visit), not the trading liquidity of
// the yfinance ticker used as its price proxy. GC=F (COMEX gold futures) is itself one of the
// most liquid futures contracts in the world - labeling the row bare "Illiquid" was a real
// mislabel, easy to misread as "this ticker is hard to trade".
var ALT_LIQUIDITY_LABELS = { illiquid: "Illiquid to hold", medium: "Medium", liquid: "Liquid" };

function initAlternatives(data) {
  var emptyEl = document.getElementById("alt-empty");
  var contentEl = document.getElementById("alt-content");
  if (!data.length) {
    contentEl.style.display = "none";
    emptyEl.hidden = false;
    emptyEl.innerHTML = "No alternatives data published yet. Run <code>python scripts/export_marts.py</code> after alternatives_ingest and dbt_transform have run at least once.";
    return;
  }

  var methodologyPanel = document.getElementById("alt-methodology-panel");
  methodologyPanel.innerHTML =
    "<h3>Return, volatility &amp; drawdown</h3>" +
    "<p>Same treatment as the PEA tab's metrics (see that tab's own methodology panel for the full derivation): <strong>period return</strong> is a median-of-5-day, not point-to-point, comparison; <strong>annualized return</strong> geometrically annualizes it - power(last_price / first_price, 252 / trading_days) - 1, not an arithmetic-mean shortcut; <strong>annualized volatility</strong> is the standard deviation of daily returns scaled by &radic;252; <strong>max drawdown</strong> is the worst peak-to-trough decline seen so far. All use adjusted close throughout.</p>" +
    "<h3>The 60-trading-day gate</h3>" +
    "<p>Annualized return/volatility/drawdown/Sharpe are all null until a ticker has 60+ trading days of ingested history - same reasoning as the PEA tab: a noisy few-day average can blow up an annualized figure, and a short history can just as easily hide risk by not having lived through a bad week yet. Shown as \"&ndash;\", never a fabricated number.</p>" +
    "<h3>Sharpe ratio</h3>" +
    "<p>(annualized return &minus; risk_free_rate_pct) / annualized volatility, same dated hand-set risk-free constant (~2.5%, illustrative French OAT baseline) the PEA tab uses - see <code>dbt_project.yml</code>.</p>" +
    "<h3>No benchmark comparison</h3>" +
    "<p>Unlike the PEA tab's \"Vs. CW8.PA\" column, this tab doesn't compute a relative-performance figure - there's no single coherent benchmark across a physical-gold proxy, a paper-gold ETF, and two cryptocurrencies the way a world-equity tracker is for a stock/ETF watchlist.</p>" +
    "<h3>Liquidity means \"to hold,\" not \"to trade\"</h3>" +
    "<p>A hand-set label per instrument (<code>dbt/seeds/alternatives_watchlist.csv</code>), not derived from trading volume, and describing how easily <em>you</em> could convert the position this row represents into cash - not the trading liquidity of the yfinance ticker itself. Physical gold is <strong>illiquid to hold</strong> (selling a bar takes time/dealer access); the paper-gold ETF and both cryptocurrencies are <strong>liquid</strong> (tradable on an exchange in seconds). This matters because the physical-gold row's own price ticker, GC=F (COMEX gold futures), is emphatically NOT illiquid as an instrument - it's one of the most liquid futures contracts that exists. GC=F is used here purely as the closest available yfinance price proxy for physical gold, since there's no direct \"gold bar in a safe\" price feed; the illiquid label is about what owning bullion is like, not about this ticker's own order-book depth.</p>" +
    "<h3>GC=F is a continuous futures series (roll yield, not spot)</h3>" +
    "<p>yfinance serves GC=F as a front-month continuous contract, spliced across expirations - not roll-yield-adjusted. Multi-year return figures for this specific row can drift from spot/ETF-based gold exposure by a few points purely from contract-roll effects, independent of gold's actual price move. <strong>GLD</strong> (a spot-tracking ETF, no roll yield) is the more standard reference if you want \"gold's realized return\" rather than \"this specific futures contract's realized return.\"</p>" +
    "<h3>Trading-days data-quality fix</h3>" +
    "<p>A real bug, found on 5 years of live-ingested data and since fixed: batching GC=F/GLD (weekday-only) alongside BTC-USD/ETH-USD (7-day/week) in one data-fetch call used to leave an all-NaN placeholder row for GC=F/GLD on every weekend/holiday only the crypto side trades - those placeholder rows were getting counted as trading days, which directly deflated the annualized-return exponent. Concretely: GLD showed a reported 12.7%/year against a true ~18.9%/year for the identical prices, purely from the wrong denominator. Now fixed both at ingestion and defensively at the data-warehouse layer - <code>trading_days</code> shown here reflects real per-ticker history.</p>" +
    "<h3>Short-window annualization is sensitive to the start date</h3>" +
    "<p>Annualizing over a couple of years (not the decades a long-run assumption would want) means the specific start/end dates chosen matter more than they would over a longer window - if the ingested history happens to start right after a sharp market dislocation (or right before one), the annualized figure can look unusually strong or weak in a way that says more about that one date than about the asset's typical behavior. The median-of-5-day robustness above only guards against a single glitchy data point, not this - it's an inherent property of measuring a still-relatively-short window on a volatile price path, and it shrinks as more history accumulates. Treat early figures here as illustrative, not stable, especially for crypto's higher volatility.</p>";
  var methodologyBtn = document.getElementById("alt-methodology-toggle");
  methodologyBtn.addEventListener("click", function () {
    var expanded = methodologyBtn.getAttribute("aria-expanded") === "true";
    methodologyBtn.setAttribute("aria-expanded", String(!expanded));
    methodologyPanel.hidden = expanded;
    methodologyBtn.textContent = expanded ? "How is this calculated?" : "Hide methodology";
  });

  var typeSelect = document.getElementById("alt-filter-type");
  var legendState = { physical_gold: true, paper_gold: true, crypto: true };

  var legendEl = document.getElementById("alt-legend");
  Object.keys(ALT_INSTRUMENT_LABELS).forEach(function (key) {
    var btn = document.createElement("button");
    btn.className = "legend-item";
    btn.setAttribute("aria-pressed", "true");
    var sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = ALT_INSTRUMENT_COLORS[key];
    btn.appendChild(sw);
    var lbl = document.createElement("span");
    lbl.textContent = ALT_INSTRUMENT_LABELS[key];
    btn.appendChild(lbl);
    btn.addEventListener("click", function () {
      legendState[key] = !legendState[key];
      btn.setAttribute("aria-pressed", String(legendState[key]));
      applyFilters();
    });
    legendEl.appendChild(btn);
  });

  // Same single-select ranking-metric toggle as the PEA tab - drives both the bar chart's
  // ranking and the table's row order.
  var BAR_METRICS = {
    annualized_return: {
      title: "Annualized return by ticker",
      tableSortLabel: "annualized return",
      valueKey: "annualized_return",
      valueFormatter: function (v) { return fmtPct1.format(v); }
    },
    sharpe_ratio: {
      title: "Sharpe ratio by ticker",
      tableSortLabel: "Sharpe ratio",
      valueKey: "sharpe_ratio",
      valueFormatter: function (v) { return fmtScore.format(v); }
    }
  };
  var barMetric = "annualized_return";
  var barMetricButtons = {
    annualized_return: document.getElementById("alt-bar-metric-return"),
    sharpe_ratio: document.getElementById("alt-bar-metric-sharpe")
  };
  Object.keys(barMetricButtons).forEach(function (key) {
    barMetricButtons[key].addEventListener("click", function () {
      if (barMetric === key) return;
      barMetric = key;
      Object.keys(barMetricButtons).forEach(function (k) { barMetricButtons[k].setAttribute("aria-pressed", String(k === key)); });
      resortAndRender();
    });
  });

  var columns = [
    { key: "ticker", label: "Ticker" },
    { key: "name", label: "Name" },
    { key: "instrument_type", label: "Instrument", format: function (v) { return ALT_INSTRUMENT_LABELS[v] || v || "–"; } },
    { key: "liquidity", label: "Liquidity", format: function (v) { return ALT_LIQUIDITY_LABELS[v] || v || "–"; } },
    { key: "first_date", label: "Since", format: function (v) { return v || "–"; } },
    { key: "last_date", label: "Until", format: function (v) { return v || "–"; } },
    { key: "annualized_return", label: "Annualized return", format: function (v) { return v == null ? "–" : fmtPct1.format(v); } },
    { key: "annualized_volatility", label: "Volatility", format: function (v) { return v == null ? "–" : fmtPct1Plain.format(v); } },
    { key: "max_drawdown_pct", label: "Max drawdown", format: function (v) { return v == null ? "–" : fmtPct1.format(v); } },
    { key: "sharpe_ratio", label: "Sharpe", format: function (v) { return v == null ? "–" : fmtScore.format(v); } }
  ];

  var currentFilteredData = data;
  var tableSortNoteEl = document.getElementById("alt-table-sort-note");
  var invalidateTable = wireTableToggle("alt-table-toggle", "alt-table-wrap", function () {
    renderTable(document.getElementById("alt-table-wrap"), currentFilteredData, columns);
  });

  function sortByCurrentMetric(rows) {
    var metricCfg = BAR_METRICS[barMetric];
    return rows.slice().sort(function (a, b) { return altSortVal(b, metricCfg) - altSortVal(a, metricCfg); });
  }

  function resortAndRender() {
    currentFilteredData = sortByCurrentMetric(currentFilteredData);
    render(currentFilteredData);
    tableSortNoteEl.textContent = "Sorted by " + BAR_METRICS[barMetric].tableSortLabel;
    var wrap = document.getElementById("alt-table-wrap");
    if (!wrap.hidden) { renderTable(wrap, currentFilteredData, columns); }
    invalidateTable();
  }

  function applyFilters() {
    var type = typeSelect.value;
    var filtered = data.filter(function (d) {
      if (type && d.instrument_type !== type) return false;
      if (!legendState[d.instrument_type]) return false;
      return true;
    });
    currentFilteredData = filtered;
    resortAndRender();
  }

  function render(filtered) {
    var statsEl = document.getElementById("alt-stats");
    statsEl.innerHTML = "";
    var best = filtered.filter(function (d) { return d.annualized_return != null; }).sort(function (a, b) { return b.annualized_return - a.annualized_return; })[0];
    function avgOf(rows, key) {
      var values = rows.map(function (d) { return d[key]; }).filter(function (v) { return v != null; });
      return values.length ? values.reduce(function (s, v) { return s + v; }, 0) / values.length : null;
    }
    var avgReturn = avgOf(filtered, "annualized_return");
    var avgVol = avgOf(filtered, "annualized_volatility");
    var bestSharpe = filtered.filter(function (d) { return d.sharpe_ratio != null; }).sort(function (a, b) { return b.sharpe_ratio - a.sharpe_ratio; })[0];
    var liquidCount = filtered.filter(function (d) { return d.liquidity === "liquid"; }).length;
    addStatTile(statsEl, "Instruments tracked", fmtInt.format(filtered.length), liquidCount + " liquid, " + (filtered.length - liquidCount) + " illiquid/medium");
    addStatTile(statsEl, "Best performer (annualized)", best ? best.ticker : "–", best ? fmtPct1.format(best.annualized_return) : "Needs 60+ trading days of history");
    addStatTile(statsEl, "Avg. annualized return", avgReturn != null ? fmtPct1.format(avgReturn) : "–", null);
    addStatTile(statsEl, "Avg. annualized volatility", avgVol != null ? fmtPct1Plain.format(avgVol) : "–", null);
    addStatTile(statsEl, "Best risk-adjusted (Sharpe)", bestSharpe ? bestSharpe.ticker : "–", bestSharpe ? "Sharpe " + fmtScore.format(bestSharpe.sharpe_ratio) : "Needs 60+ trading days of history");

    var metricCfg = BAR_METRICS[barMetric];
    document.getElementById("alt-bar-title").textContent = metricCfg.title;
    var barItems = filtered.filter(function (d) { return d[metricCfg.valueKey] != null; })
      .sort(function (a, b) { return b[metricCfg.valueKey] - a[metricCfg.valueKey]; })
      .map(function (d) {
        return {
          label: d.ticker,
          value: d[metricCfg.valueKey],
          extra: [["Name", d.name || d.ticker], ["Instrument", ALT_INSTRUMENT_LABELS[d.instrument_type] || d.instrument_type || "–"], ["Trading days", fmtInt.format(d.trading_days)]]
        };
      });
    renderDivergingBarChart(document.getElementById("alt-bar"), barItems, { valueFormatter: metricCfg.valueFormatter });

    renderScatterChart(document.getElementById("alt-scatter"), filtered.filter(function (d) { return d.annualized_volatility != null && d.annualized_return != null; }).map(function (d) {
      return {
        x: d.annualized_volatility,
        y: d.annualized_return,
        label: d.ticker,
        color: ALT_INSTRUMENT_COLORS[d.instrument_type] || "var(--series-1)",
        group: d.instrument_type,
        extra: [["Name", d.name || d.ticker], ["Annualized return", fmtPct1.format(d.annualized_return)], ["Annualized volatility", fmtPct1Plain.format(d.annualized_volatility)]]
      };
    }), {
      width: 900, height: 340,
      xTickFormatter: function (v) { return fmtPct1Plain.format(v); },
      yTickFormatter: function (v) { return fmtPct1.format(v); },
      ariaLabel: "Annualized volatility versus annualized return, one dot per instrument",
      emptyMessage: "No instrument has 60+ trading days of history yet - see \"How is this calculated?\"."
    });
  }

  typeSelect.addEventListener("change", applyFilters);
  applyFilters();
}
