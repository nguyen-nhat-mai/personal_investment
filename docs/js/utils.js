"use strict";
// Shared across every tab: number/currency/percent formatters, the shared tooltip element,
// the generic table-view renderer, the SVG element helper, and the stat-tile builder. Loaded
// first (see index.html's <script> order) - everything else on this page depends on these.

/* ---------- formatting ---------- */
var fmtInt = new Intl.NumberFormat("fr-FR");
var fmtEUR0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
// For small per-share values (dividends) where rounding to 0 decimals would hide the number
// entirely - fmtEUR0.format(0.85) is "0 EUR", fmtEUR2.format(0.85) is "0,85 EUR".
var fmtEUR2 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Signed: for EUR deltas (e.g. the wealth simulator's risk-tolerance comparison) where +/- is
// the point - plain fmtEUR0 shows "-" for negatives but nothing for positives.
var fmtEUR0Signed = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0, signDisplay: "exceptZero" });
// Signed: for deltas (YoY change, period return) where +/- is the point.
var fmtPct1 = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });
// Unsigned: for magnitudes that are never negative (volatility) - a "+" there would
// misread as a delta.
var fmtPct1Plain = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 });
var fmtScore = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

/* ---------- tooltip ---------- */
var tooltipEl = document.getElementById("tooltip");
function showTooltip(evt, title, rows) {
  tooltipEl.innerHTML = "";
  var t = document.createElement("div");
  t.className = "tt-title";
  t.textContent = title;
  tooltipEl.appendChild(t);
  rows.forEach(function (r) {
    var row = document.createElement("div");
    row.className = "tt-row";
    var k = document.createElement("span");
    k.className = "tt-key";
    k.textContent = r[0];
    var v = document.createElement("span");
    v.className = "tt-val";
    v.textContent = r[1];
    row.appendChild(k);
    row.appendChild(v);
    tooltipEl.appendChild(row);
  });
  tooltipEl.hidden = false;
  positionTooltip(evt);
}
function positionTooltip(evt) {
  var x = evt.clientX, y = evt.clientY;
  var pad = 14;
  var rect = tooltipEl.getBoundingClientRect();
  var left = Math.min(x + pad, window.innerWidth - rect.width - 8);
  var top = Math.min(y + pad, window.innerHeight - rect.height - 8);
  tooltipEl.style.left = Math.max(8, left) + "px";
  tooltipEl.style.top = Math.max(8, top) + "px";
}
function hideTooltip() { tooltipEl.hidden = true; }

/* ---------- generic table view ---------- */
function renderTable(container, rows, columns) {
  container.innerHTML = "";
  var table = document.createElement("table");
  table.className = "data-table";
  var thead = document.createElement("thead");
  var htr = document.createElement("tr");
  columns.forEach(function (c) {
    var th = document.createElement("th");
    th.textContent = c.label;
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);
  var tbody = document.createElement("tbody");
  rows.forEach(function (row) {
    var tr = document.createElement("tr");
    columns.forEach(function (c) {
      var td = document.createElement("td");
      var v = row[c.key];
      td.textContent = c.format ? c.format(v) : (v == null ? "" : v);
      // colorFn is optional (e.g. "vs Avg." delta columns) - green/red on sign, same
      // --diverging-pos/--diverging-neg tokens used everywhere else a +/- carries meaning.
      // Existing column defs without colorFn are unaffected.
      if (c.colorFn) {
        var color = c.colorFn(v, row);
        if (color) td.style.color = color;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}
function wireTableToggle(btnId, wrapId, renderFn) {
  var btn = document.getElementById(btnId);
  var wrap = document.getElementById(wrapId);
  var rendered = false;
  btn.addEventListener("click", function () {
    var expanded = btn.getAttribute("aria-expanded") === "true";
    if (!expanded && !rendered) { renderFn(); rendered = true; }
    btn.setAttribute("aria-expanded", String(!expanded));
    wrap.hidden = expanded;
    btn.textContent = expanded ? "Show table view" : "Hide table view";
  });
  return function invalidate() { rendered = false; };
}

/* ---------- SVG element helper (used by charts.js and wealth-sim.js) ---------- */
var SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  var el = document.createElementNS(SVGNS, tag);
  for (var k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

/* ---------- stat tile (used by every tab) ---------- */
// sub accepts either a plain string (existing callers, colored via subColor) or an array of
// { text, color } lines (e.g. two independent notes on one tile) - both render as stacked
// ".sub" divs, so no new CSS is needed either way.
function addStatTile(container, label, value, sub, selected, subColor) {
  var tile = document.createElement("div");
  tile.className = "stat-tile" + (selected ? " selected" : "");
  var l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  var v = document.createElement("div");
  v.className = "value";
  v.textContent = value;
  tile.appendChild(l);
  tile.appendChild(v);
  var subLines = Array.isArray(sub) ? sub : (sub ? [{ text: sub, color: subColor }] : []);
  subLines.forEach(function (line) {
    if (!line || !line.text) return;
    var s = document.createElement("div");
    s.className = "sub";
    // color is for a delta/comparison sub-line (e.g. "+12 345 EUR vs. current") where
    // sign carries real meaning - same --diverging-pos/--diverging-neg tokens the bar charts
    // already use for gains/losses, not a new color language.
    if (line.color) s.style.color = line.color;
    s.textContent = line.text;
    tile.appendChild(s);
  });
  container.appendChild(tile);
}
