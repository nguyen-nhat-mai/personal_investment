"use strict";
// Real estate tab. Depends on utils.js and charts.js (fmt*, showTooltip/hideTooltip via chart
// primitives, renderTable, wireTableToggle, svgEl, renderMagnitudeBarChart, renderScatterChart,
// renderChoropleth, renderTopDepartments, addStatTile) - must load after both.

function medianOf(arr) {
  if (!arr.length) return null;
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
var TYPE_COLORS = { Maison: "var(--series-1)", Appartement: "var(--series-2)" };
function typeColor(t) { return TYPE_COLORS[t] || "var(--series-1)"; }

function initRealEstate(data, departmentsGeo) {
  var emptyEl = document.getElementById("re-empty");
  var contentEl = document.getElementById("re-content");
  if (!data.length) {
    contentEl.style.display = "none";
    emptyEl.hidden = false;
    emptyEl.innerHTML = "No real-estate data published yet. Run <code>python scripts/export_marts.py</code> after dvf_ingest, insee_ingest, and dbt_transform have run at least once.";
    return;
  }

  // methodology disclosure - static content, wired once
  var methodologyPanel = document.getElementById("re-methodology-panel");
  methodologyPanel.innerHTML =
    "<h3>Opportunity score</h3>" +
    "<p>For each commune and property type, using the most recent DVF year in the data, communes need at least 2,000 population and at least 15 qualifying sales that year to be scored at all &mdash; both are hard cutoffs dropping micro-markets entirely, on top of (not instead of) the separate 5-sale bar that just governs whether a given year's median price is statistically trustworthy. Communes with no population figure on file are dropped too, since a hard cutoff can't verify what it can't measure.</p>" +
    "<p>The score (0&ndash;100) blends five factors, proportionally rescaled from a suggested six-factor weighting so they still sum to 100: up to ~22 points for being cheaper than the national median price/m&sup2; (capped at 2&times; the national median); up to ~22 points for multi-year price CAGR (capped at &plusmn;15%/year); up to ~22 points for transaction liquidity (this year's sales per capita, capped at 2%); up to ~17 points for population growth, 2017&ndash;2021 CAGR (capped at &plusmn;5%/year); up to ~17 points for local median disposable income, capped at &euro;30,000. See <code>dbt/models/marts/real_estate/commune_opportunity_score.sql</code> for the exact formula &mdash; it's simple and transparent on purpose, tune the weights to what you actually care about.</p>" +
    "<h3>Property tax penalty</h3>" +
    "<p>Property tax rate isn't a full sixth weighted factor (reweighting all five above is still a pending decision), but egregious outliers now cost points as a guard rail: communes with a property tax rate (taux_foncier_bati) above 35% lose points, ramping linearly up to a maximum 15-point deduction at 2&times; that threshold (70%) &mdash; e.g. a commune at 73.1% would take the full 15-point penalty. Below 35%, or where no tax data is on file, there's no penalty.</p>" +
    "<h3>Price &amp; population CAGR</h3>" +
    "<p><strong>Price CAGR</strong>: compound annual growth rate between the earliest and latest years with at least 5 qualifying sales for that commune/type &mdash; not a fixed window, just whatever span of reliable DVF years is ingested (currently up to 2021&ndash;2024). Communes without at least a 2-year reliable window score as neutral (0%) rather than being excluded. <strong>Population CAGR</strong>: growth rate across 2017&ndash;2021 (the fullest reliable series available - see &ldquo;How it works&rdquo; for why it's not more current), from official INSEE census figures, not DVF.</p>" +
    "<h3>Data-quality filters</h3>" +
    "<p>Excludes forced auctions, property exchanges, and expropriations (none reflect a market price), and excludes transactions priced below &euro;100/m&sup2; or above &euro;30,000/m&sup2; (data-entry errors, not real outliers &mdash; found via a real anomaly that showed a +2,933,233% year-over-year change before these filters existed).</p>";
  var methodologyBtn = document.getElementById("re-methodology-toggle");
  methodologyBtn.addEventListener("click", function () {
    var expanded = methodologyBtn.getAttribute("aria-expanded") === "true";
    methodologyBtn.setAttribute("aria-expanded", String(!expanded));
    methodologyPanel.hidden = expanded;
    methodologyBtn.textContent = expanded ? "How is this calculated?" : "Hide methodology";
  });

  var depts = Array.from(new Set(data.map(function (d) { return d.code_departement + " — " + (d.nom_departement || ""); })))
    .sort();
  var deptSelect = document.getElementById("re-filter-dept");
  depts.forEach(function (d) {
    var code = d.split(" — ")[0];
    var opt = document.createElement("option");
    opt.value = code;
    opt.textContent = d;
    deptSelect.appendChild(opt);
  });
  var types = Array.from(new Set(data.map(function (d) { return d.type_local; }))).sort();
  var typeSelect = document.getElementById("re-filter-type");
  types.forEach(function (t) {
    var opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    typeSelect.appendChild(opt);
  });

  // legend: property type, doubles as a toggle-to-isolate filter alongside the dropdown
  var legendState = {};
  types.forEach(function (t) { legendState[t] = true; });
  var legendEl = document.getElementById("re-legend");
  types.forEach(function (t) {
    var btn = document.createElement("button");
    btn.className = "legend-item";
    btn.setAttribute("aria-pressed", "true");
    var sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = typeColor(t);
    btn.appendChild(sw);
    var lbl = document.createElement("span");
    lbl.textContent = t;
    btn.appendChild(lbl);
    btn.addEventListener("click", function () {
      legendState[t] = !legendState[t];
      btn.setAttribute("aria-pressed", String(legendState[t]));
      applyFilters();
    });
    legendEl.appendChild(btn);
  });

  var tableColumns = [
    { key: "nom_commune", label: "Commune" },
    { key: "code_departement", label: "Dept" },
    { key: "type_local", label: "Type" },
    { key: "opportunity_score", label: "Score", format: function (v) { return fmtScore.format(v); } },
    { key: "median_price_per_sqm", label: "Price/m²", format: function (v) { return v == null ? "–" : fmtEUR0.format(v); } },
    { key: "price_cagr", label: "Price CAGR", format: function (v) { return v == null ? "–" : fmtPct1.format(v); } },
    { key: "transactions_per_capita", label: "Sales/capita", format: function (v) { return v == null ? "–" : fmtPct1Plain.format(v); } },
    { key: "median_disposable_income", label: "Median income", format: function (v) { return v == null ? "–" : fmtEUR0.format(v); } },
    // taux_foncier_bati is already a percentage value (e.g. 43.9 meaning 43.9%), not a 0-1
    // fraction like the other percent fields here - divide by 100 before reusing the
    // percent formatter rather than adding a whole separate formatter for one field.
    { key: "taux_foncier_bati", label: "Property tax", format: function (v) { return v == null ? "–" : fmtPct1Plain.format(v / 100); } },
    { key: "population", label: "Population", format: function (v) { return v == null ? "–" : fmtInt.format(v); } },
    { key: "population_cagr", label: "Pop. CAGR", format: function (v) { return v == null ? "–" : fmtPct1.format(v); } },
    { key: "population_share_of_department", label: "% of dept. pop.", format: function (v) { return v == null ? "–" : fmtPct1Plain.format(v); } }
  ];

  var invalidateTable = wireTableToggle("re-table-toggle", "re-table-wrap", function () {
    renderTable(document.getElementById("re-table-wrap"), currentFiltered(), tableColumns);
  });

  var currentFilteredData = data;
  function currentFiltered() { return currentFilteredData; }

  function applyFilters() {
    var dept = deptSelect.value, type = typeSelect.value;
    var filtered = data.filter(function (d) {
      return (!dept || d.code_departement === dept) && (!type || d.type_local === type) && legendState[d.type_local];
    });
    currentFilteredData = filtered.slice().sort(function (a, b) { return b.opportunity_score - a.opportunity_score; });
    render(currentFilteredData);
    invalidateTable();
    var wrap = document.getElementById("re-table-wrap");
    if (!wrap.hidden) renderTable(wrap, currentFilteredData, tableColumns);
  }

  function render(filtered) {
    // stats
    var statsEl = document.getElementById("re-stats");
    statsEl.innerHTML = "";
    var communeCount = new Set(filtered.map(function (d) { return d.code_commune; })).size;
    var top = filtered.slice().sort(function (a, b) { return b.opportunity_score - a.opportunity_score; })[0];
    var nationalMedian = filtered.length ? filtered[0].national_median_price_per_sqm : null;
    addStatTile(statsEl, "Communes analyzed", fmtInt.format(communeCount), null);
    addStatTile(statsEl, "Top opportunity", top ? top.nom_commune : "–", top ? "Score " + fmtScore.format(top.opportunity_score) : null);
    addStatTile(statsEl, "National median price/m²", nationalMedian != null ? fmtEUR0.format(nationalMedian) : "–", filtered.length ? "Year " + filtered[0].year : null);

    // map: department medians recomputed from whatever the filters currently show
    if (departmentsGeo) {
      var byDept = {};
      filtered.forEach(function (d) {
        (byDept[d.code_departement] = byDept[d.code_departement] || { rows: [], nom: d.nom_departement }).rows.push(d);
      });
      var dataByCode = {};
      Object.keys(byDept).forEach(function (code) {
        var rows = byDept[code];
        var med = medianOf(rows.rows.map(function (r) { return r.opportunity_score; }));
        dataByCode[code] = {
          value: med,
          label: rows.nom || code,
          extra: [["Communes", fmtInt.format(new Set(rows.rows.map(function (r) { return r.code_commune; })).size)]]
        };
      });
      renderChoropleth(document.getElementById("re-map"), document.getElementById("re-map-legend"), departmentsGeo, dataByCode, {
        width: 640,
        valueLabel: "Median score",
        valueFormatter: function (v) { return fmtScore.format(v); },
        ariaLabel: "Median opportunity score by département"
      });
      renderTopDepartments(document.getElementById("re-map-top"), dataByCode, {
        valueFormatter: function (v) { return fmtScore.format(v); }
      });
    }

    // bar chart: top 15, colored by property type
    var top15 = filtered.slice().sort(function (a, b) { return b.opportunity_score - a.opportunity_score; }).slice(0, 15);
    renderMagnitudeBarChart(document.getElementById("re-bar"), top15.map(function (d) {
      return {
        label: d.nom_commune,
        value: d.opportunity_score,
        color: typeColor(d.type_local),
        extra: [["Type", d.type_local], ["Price/m²", fmtEUR0.format(d.median_price_per_sqm)], ["Price CAGR", d.price_cagr == null ? "–" : fmtPct1.format(d.price_cagr)], ["Pop. CAGR", d.population_cagr == null ? "–" : fmtPct1.format(d.population_cagr)], ["Dept", d.code_departement]]
      };
    }), { valueFormatter: function (v) { return fmtScore.format(v); } });

    // scatter, colored by property type
    renderScatterChart(document.getElementById("re-scatter"), filtered.filter(function (d) { return d.median_price_per_sqm != null; }).map(function (d) {
      return {
        x: d.median_price_per_sqm,
        y: d.opportunity_score,
        label: d.nom_commune,
        color: typeColor(d.type_local),
        group: d.type_local,
        extra: [["Type", d.type_local], ["Price/m²", fmtEUR0.format(d.median_price_per_sqm)], ["Price CAGR", d.price_cagr == null ? "–" : fmtPct1.format(d.price_cagr)], ["Pop. CAGR", d.population_cagr == null ? "–" : fmtPct1.format(d.population_cagr)], ["Score", fmtScore.format(d.opportunity_score)], ["Dept", d.code_departement]]
      };
    }), {
      width: 900, height: 340,
      xTickFormatter: function (v) { return fmtEUR0.format(v); },
      yTickFormatter: function (v) { return fmtScore.format(v); },
      ariaLabel: "Price per square meter versus opportunity score, one dot per commune"
    });
  }

  deptSelect.addEventListener("change", applyFilters);
  typeSelect.addEventListener("change", applyFilters);
  applyFilters();
}
