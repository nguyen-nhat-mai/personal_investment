"use strict";
// Chart primitives shared across tabs. Depends on utils.js (svgEl, showTooltip, hideTooltip) -
// must load after it.

/* ---------- HTML bar chart (sequential, single hue, magnitude) ---------- */
function renderMagnitudeBarChart(container, items, opts) {
  // items: [{label, value}], all values assumed >= 0
  container.innerHTML = "";
  var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([0]));
  items.forEach(function (item) {
    var row = document.createElement("div");
    row.className = "bar-row";
    row.tabIndex = 0;

    var label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = item.label;
    label.title = item.label;

    var track = document.createElement("div");
    track.className = "bar-track";
    var fill = document.createElement("div");
    fill.className = "bar-fill";
    var widthPct = max > 0 ? (item.value / max) * 100 : 0;
    fill.style.width = widthPct + "%";
    fill.style.left = "0";
    fill.style.background = item.color || "var(--series-1)";
    track.appendChild(fill);

    var value = document.createElement("div");
    value.className = "bar-value";
    value.textContent = opts.valueFormatter(item.value);

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(value);

    var tipRows = [["Value", opts.valueFormatter(item.value)]];
    if (item.extra) tipRows = item.extra.concat(tipRows);
    row.addEventListener("pointermove", function (e) { showTooltip(e, item.label, tipRows); });
    row.addEventListener("pointerleave", hideTooltip);
    row.addEventListener("focus", function (e) { showTooltip(e, item.label, tipRows); });
    row.addEventListener("blur", hideTooltip);

    container.appendChild(row);
  });
}

/* ---------- HTML bar chart (diverging around zero) ---------- */
function renderDivergingBarChart(container, items, opts) {
  // items: [{label, value, extra}]
  container.innerHTML = "";
  var maxAbs = Math.max.apply(null, items.map(function (i) { return Math.abs(i.value); }).concat([0.0001]));
  items.forEach(function (item) {
    var row = document.createElement("div");
    row.className = "bar-row";
    row.tabIndex = 0;

    var label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = item.label;
    label.title = item.label;

    var track = document.createElement("div");
    track.className = "bar-track diverging";

    var zero = document.createElement("div");
    zero.className = "bar-zero-line";
    zero.style.left = "50%";
    track.appendChild(zero);

    var fill = document.createElement("div");
    var pct = (Math.abs(item.value) / maxAbs) * 50; // half-width max
    var isNeg = item.value < 0;
    fill.className = "bar-fill" + (isNeg ? " neg" : "");
    fill.style.width = pct + "%";
    fill.style.left = isNeg ? (50 - pct) + "%" : "50%";
    fill.style.background = isNeg ? "var(--diverging-neg)" : "var(--diverging-pos)";
    track.appendChild(fill);

    var value = document.createElement("div");
    value.className = "bar-value";
    value.textContent = opts.valueFormatter(item.value);
    // Text stays in the neutral ink token regardless of sign - the bar's fill color
    // already carries the positive/negative signal; the label doesn't repeat it.

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(value);

    var tipRows = (item.extra || []).concat([["Return", opts.valueFormatter(item.value)]]);
    row.addEventListener("pointermove", function (e) { showTooltip(e, item.label, tipRows); });
    row.addEventListener("pointerleave", hideTooltip);
    row.addEventListener("focus", function (e) { showTooltip(e, item.label, tipRows); });
    row.addEventListener("blur", hideTooltip);

    container.appendChild(row);
  });
}

/* ---------- SVG scatter chart ---------- */
function renderScatterChart(container, points, opts) {
  // points: [{x, y, label, color, group, extra}]
  container.innerHTML = "";
  if (!points.length) {
    // Math.min/max.apply(null, []) is +/-Infinity, and (-Infinity) is truthy in JS - so the
    // `|| 1` padding fallback further down never kicks in, and every axis label renders as
    // NaN instead of a friendly empty state. Bail out before any of that math runs.
    var msg = document.createElement("p");
    msg.className = "caption-note";
    msg.textContent = opts.emptyMessage || "Not enough data yet.";
    container.appendChild(msg);
    return null;
  }
  var W = opts.width || 640, H = opts.height || 320;
  var margin = { top: 12, right: 16, bottom: 34, left: 56 };
  var innerW = W - margin.left - margin.right;
  var innerH = H - margin.top - margin.bottom;

  var xs = points.map(function (p) { return p.x; });
  var ys = points.map(function (p) { return p.y; });
  var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
  var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
  var xPad = (xMax - xMin) * 0.08 || 1, yPad = (yMax - yMin) * 0.08 || 1;
  xMin -= xPad; xMax += xPad; yMin -= yPad; yMax += yPad;

  function sx(v) { return margin.left + ((v - xMin) / (xMax - xMin)) * innerW; }
  function sy(v) { return margin.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH; }

  var svg = svgEl("svg", { class: "scatter", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": opts.ariaLabel || "scatter chart" });

  // gridlines (4 horizontal, 4 vertical)
  var GRID = 4;
  for (var i = 0; i <= GRID; i++) {
    var gy = margin.top + (innerH / GRID) * i;
    svg.appendChild(svgEl("line", { class: "gridline", x1: margin.left, x2: margin.left + innerW, y1: gy, y2: gy }));
    var yVal = yMax - ((yMax - yMin) / GRID) * i;
    var yLabel = svgEl("text", { class: "axis-label", x: margin.left - 8, y: gy + 3, "text-anchor": "end" });
    yLabel.textContent = opts.yTickFormatter(yVal);
    svg.appendChild(yLabel);
  }
  for (var j = 0; j <= GRID; j++) {
    var gx = margin.left + (innerW / GRID) * j;
    var xVal = xMin + ((xMax - xMin) / GRID) * j;
    var xLabel = svgEl("text", { class: "axis-label", x: gx, y: H - 8, "text-anchor": "middle" });
    xLabel.textContent = opts.xTickFormatter(xVal);
    svg.appendChild(xLabel);
  }
  // axes baseline
  svg.appendChild(svgEl("line", { class: "axis-line", x1: margin.left, x2: margin.left, y1: margin.top, y2: margin.top + innerH }));
  svg.appendChild(svgEl("line", { class: "axis-line", x1: margin.left, x2: margin.left + innerW, y1: margin.top + innerH, y2: margin.top + innerH }));

  points.forEach(function (p) {
    var cx = sx(p.x), cy = sy(p.y);
    var g = svgEl("g", {});
    var hit = svgEl("circle", { class: "dot-hit", cx: cx, cy: cy, r: 12 });
    var dot = svgEl("circle", { class: "dot", cx: cx, cy: cy, r: 5, fill: p.color || "var(--series-1)", "data-group": p.group || "" });
    g.appendChild(hit);
    g.appendChild(dot);
    g.setAttribute("tabindex", "0");
    var tipRows = (p.extra || []);
    g.addEventListener("pointermove", function (e) { showTooltip(e, p.label, tipRows); });
    g.addEventListener("pointerleave", hideTooltip);
    g.addEventListener("focus", function (e) { showTooltip(e, p.label, tipRows); });
    g.addEventListener("blur", hideTooltip);
    svg.appendChild(g);
  });

  container.appendChild(svg);
  return svg;
}

/* ---------- choropleth map (SVG, hand-rolled equirectangular projection) ---------- */
// No mapping library - France is small/simple enough at country scale that a plain
// equirectangular projection with a latitude-corrected longitude scale (so 1 degree of
// longitude and 1 degree of latitude cover the same true distance at France's latitude)
// looks correct without pulling in a dependency.
function computeGeoBounds(geojson) {
  var lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  function visit(coords, depth) {
    if (depth === 0) {
      var lon = coords[0], lat = coords[1];
      if (lon < lonMin) lonMin = lon;
      if (lon > lonMax) lonMax = lon;
      if (lat < latMin) latMin = lat;
      if (lat > latMax) latMax = lat;
    } else {
      coords.forEach(function (c) { visit(c, depth - 1); });
    }
  }
  geojson.features.forEach(function (f) {
    var g = f.geometry;
    visit(g.coordinates, g.type === "Polygon" ? 2 : 3);
  });
  return { lonMin: lonMin, lonMax: lonMax, latMin: latMin, latMax: latMax };
}

function buildProjection(bounds, targetWidth) {
  var cosLat0 = Math.cos((bounds.latMin + bounds.latMax) / 2 * Math.PI / 180);
  var k = targetWidth / ((bounds.lonMax - bounds.lonMin) * cosLat0);
  var height = (bounds.latMax - bounds.latMin) * k;
  return {
    width: targetWidth,
    height: height,
    project: function (lon, lat) {
      return [(lon - bounds.lonMin) * cosLat0 * k, (bounds.latMax - lat) * k];
    }
  };
}

function ringToPathD(ring, project) {
  return ring.map(function (pt, i) {
    var p = project(pt[0], pt[1]);
    return (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1);
  }).join(" ") + " Z";
}

function geometryToPathD(geometry, project) {
  if (geometry.type === "Polygon") {
    return geometry.coordinates.map(function (ring) { return ringToPathD(ring, project); }).join(" ");
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map(function (poly) {
      return poly.map(function (ring) { return ringToPathD(ring, project); }).join(" ");
    }).join(" ");
  }
  return "";
}

function renderChoropleth(container, legendContainer, geojson, dataByCode, opts) {
  // dataByCode: { [code_departement]: { value, label, extra } }
  container.innerHTML = "";
  legendContainer.innerHTML = "";

  var bounds = computeGeoBounds(geojson);
  var proj = buildProjection(bounds, opts.width || 640);
  var values = Object.keys(dataByCode).map(function (k) { return dataByCode[k].value; });
  var min = Math.min.apply(null, values), max = Math.max.apply(null, values);

  var svg = svgEl("svg", {
    class: "choropleth",
    viewBox: "0 0 " + proj.width.toFixed(1) + " " + proj.height.toFixed(1),
    role: "img",
    "aria-label": opts.ariaLabel || "choropleth map"
  });

  geojson.features.forEach(function (f) {
    var code = f.properties.code;
    var d = geometryToPathD(f.geometry, proj.project);
    var entry = dataByCode[code];
    var path = svgEl("path", { d: d, tabindex: "0" });

    if (entry) {
      path.setAttribute("class", "map-dept");
      var t = max > min ? (entry.value - min) / (max - min) : 0.5;
      path.style.setProperty("--t", t.toFixed(3));
      var tipRows = (entry.extra || []).concat([[opts.valueLabel || "Value", opts.valueFormatter(entry.value)]]);
      path.addEventListener("pointermove", function (e) { showTooltip(e, entry.label, tipRows); });
      path.addEventListener("pointerleave", hideTooltip);
      path.addEventListener("focus", function (e) { showTooltip(e, entry.label, tipRows); });
      path.addEventListener("blur", hideTooltip);
    } else {
      path.setAttribute("class", "map-dept no-data");
      var name = f.properties.nom || code;
      path.addEventListener("pointermove", function (e) { showTooltip(e, name, [["Status", "No DVF data (excluded or no qualifying sales)"]]); });
      path.addEventListener("pointerleave", hideTooltip);
    }
    svg.appendChild(path);
  });

  container.appendChild(svg);

  var lowLabel = document.createElement("span");
  lowLabel.textContent = opts.valueFormatter(min);
  var bar = document.createElement("span");
  bar.className = "map-legend-bar";
  var highLabel = document.createElement("span");
  highLabel.textContent = opts.valueFormatter(max);
  var noDataSwatch = document.createElement("span");
  noDataSwatch.className = "map-legend-swatch";
  var noDataLabel = document.createElement("span");
  noDataLabel.textContent = "No data";
  legendContainer.appendChild(lowLabel);
  legendContainer.appendChild(bar);
  legendContainer.appendChild(highLabel);
  legendContainer.appendChild(noDataSwatch);
  legendContainer.appendChild(noDataLabel);
}

function renderTopDepartments(container, dataByCode, opts) {
  container.innerHTML = "";
  var entries = Object.keys(dataByCode)
    .map(function (code) { return { label: dataByCode[code].label, value: dataByCode[code].value }; })
    .sort(function (a, b) { return b.value - a.value; })
    .slice(0, 5);

  var heading = document.createElement("h4");
  heading.textContent = "Top 5 départements";
  container.appendChild(heading);

  if (!entries.length) {
    var empty = document.createElement("p");
    empty.style.fontSize = "12px";
    empty.style.color = "var(--text-muted)";
    empty.textContent = "No data for the current filters.";
    container.appendChild(empty);
    return;
  }

  entries.forEach(function (e, i) {
    var row = document.createElement("div");
    row.className = "map-top-item";

    var rank = document.createElement("span");
    rank.className = "map-top-rank";
    rank.textContent = (i + 1) + ".";

    var name = document.createElement("span");
    name.className = "map-top-name";
    name.textContent = e.label;
    name.title = e.label;

    var score = document.createElement("span");
    score.className = "map-top-score";
    score.textContent = opts.valueFormatter(e.value);

    row.appendChild(rank);
    row.appendChild(name);
    row.appendChild(score);
    container.appendChild(row);
  });
}
