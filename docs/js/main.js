"use strict";
// Entry point: theme toggle, tab switching, and the data-loading bootstrap that fetches every
// mart's JSON and hands it to each tab's init function. Loaded last (see index.html) - calls
// initRealEstate/initPortfolio/initWealthSimulator, which must already be defined.

/* ---------- theme toggle ---------- */
var themeBtn = document.getElementById("theme-toggle");
var THEME_ORDER = ["system", "light", "dark"];
function currentTheme() { return localStorage.getItem("theme") || "system"; }
function applyTheme(t) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  themeBtn.textContent = "Theme: " + t;
}
themeBtn.addEventListener("click", function () {
  var next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
  localStorage.setItem("theme", next);
  applyTheme(next);
});
applyTheme(currentTheme());

/* ---------- tabs ---------- */
var TABS = [
  { id: "ws", btn: document.getElementById("tab-btn-ws"), panel: document.getElementById("tab-wealth-sim") },
  { id: "re", btn: document.getElementById("tab-btn-re"), panel: document.getElementById("tab-real-estate") },
  { id: "pf", btn: document.getElementById("tab-btn-pf"), panel: document.getElementById("tab-portfolio") },
  { id: "alt", btn: document.getElementById("tab-btn-alt"), panel: document.getElementById("tab-alternatives") },
  { id: "how", btn: document.getElementById("tab-btn-how"), panel: document.getElementById("tab-how-it-works") }
];
function selectTab(which) {
  TABS.forEach(function (t) {
    var on = t.id === which;
    t.btn.setAttribute("aria-selected", String(on));
    t.panel.hidden = !on;
  });
}
TABS.forEach(function (t) {
  t.btn.addEventListener("click", function () { selectTab(t.id); });
});

/* ---------- data loading ---------- */
function fetchJson(path) {
  return fetch(path, { cache: "no-cache" }).then(function (r) {
    if (!r.ok) throw new Error("missing " + path);
    return r.json();
  }).catch(function () { return null; });
}

// Note: department_opportunity_score.json (the dbt mart) is exported alongside these but
// deliberately not fetched here - the map below recomputes department medians client-side
// from whatever the commune-level filters currently show, so it stays consistent with the
// rest of the page instead of always displaying a static all-types blend. The dbt mart is
// still a legitimate standalone artifact for anyone querying BigQuery/the JSON directly.
Promise.all([
  fetchJson("data/commune_opportunity_score.json"),
  fetchJson("data/departements.geojson"),
  fetchJson("data/equity_performance_summary.json"),
  fetchJson("data/alternatives_performance_summary.json"),
  fetchJson("data/wealth_assumptions.json"),
  fetchJson("data/meta.json")
]).then(function (res) {
  var realEstate = res[0] || [];
  var departmentsGeo = res[1];
  var portfolio = res[2] || [];
  var alternatives = res[3] || [];
  var wealthAssumptions = res[4];
  var meta = res[5];

  var metaLine = document.getElementById("meta-line");
  if (meta && meta.exported_at) {
    metaLine.textContent = "Last refreshed " + new Date(meta.exported_at).toLocaleString("en-GB");
  } else {
    metaLine.textContent = "No export yet — see footer for how to publish one.";
  }

  initRealEstate(realEstate, departmentsGeo);
  initPortfolio(portfolio);
  initAlternatives(alternatives);
  initWealthSimulator(wealthAssumptions);
});
