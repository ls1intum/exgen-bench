const CATALOG_URL = "./data/catalog.json";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PUBLIC_PATH =
  /^\.\/(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/;

const state = {
  release: null,
  releaseUrl: null,
  search: new URLSearchParams(window.location.search).get("q") ?? "",
  outcome: new URLSearchParams(window.location.search).get("outcome") ?? "all",
  dialogOpener: null,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function percent(value, digits = 0) {
  if (value === null || value === undefined) return "not applicable";
  if (!Number.isFinite(value)) throw new Error("Expected a finite rate");
  return new Intl.NumberFormat("en", {
    style: "percent",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function cssPercent(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Expected a rate between zero and one");
  }
  return `${value * 100}%`;
}

function signedPoints(value) {
  const points = value * 100;
  return `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pp`;
}

function statusLabel(status) {
  return status.replaceAll("_", " ");
}

function validHexColor(value) {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    throw new Error("Expected a six-digit hexadecimal color");
  }
  return value;
}

function applySystemStyle(node, system) {
  node.style.setProperty("--system-color", validHexColor(system.color));
  node.style.setProperty("--symbol-radius", system.symbol === "square" ? "2px" : "50%");
}

function setColor(node, property, color) {
  node.style.setProperty(property, validHexColor(color));
}

function isSafeRelativePath(path) {
  return typeof path === "string" && PUBLIC_PATH.test(path);
}

function relativeDownloadUrl(path) {
  if (!isSafeRelativePath(path)) {
    throw new Error("Download paths must be relative to the versioned release");
  }
  return new URL(path, state.releaseUrl).href;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.json();
}

function renderReleaseIdentity(release) {
  document.title = `${release.title} · exgen-bench`;
  document.querySelector("#release-summary").textContent = release.summary;
  document.querySelector("#release-status").textContent = statusLabel(release.status);
  document.querySelector("#release-note").textContent = release.notice;

  const identity = document.querySelector("#release-identity");
  const values = [
    ["Release", release.release_id],
    ["Version", release.release_version],
    ["Published", release.published_at],
    ["Cases", String(release.scope.cases)],
    ["Systems", String(release.scope.systems)],
  ];
  identity.replaceChildren(
    ...values.map(([term, description]) => {
      const row = element("div");
      row.append(element("dt", "", term), element("dd", "", description));
      return row;
    }),
  );

  const demoBanner = document.querySelector("[data-demo-banner]");
  demoBanner.hidden = release.status !== "illustrative";
}

function renderSystems(release) {
  const container = document.querySelector("#system-results");
  container.replaceChildren(
    ...release.systems.map((system) => {
      const card = element("article", "system-card");
      applySystemStyle(card, system);

      const header = element("div", "system-card-header");
      const titleWrap = element("div");
      const name = element("h3", "system-name");
      name.append(element("span", "system-symbol", system.name));
      titleWrap.append(name, element("p", "case-id", system.description));
      header.append(titleWrap, element("span", "system-badge", statusLabel(release.status)));

      const estimateRow = element("div", "estimate-row");
      estimateRow.append(
        element("div", "estimate", percent(system.primary.estimate, 1)),
        element(
          "div",
          "estimate-context",
          `${system.primary.numerator} accepted / ${system.primary.denominator} planned`,
        ),
      );

      const interval = element("div", "interval-track");
      const line = element("span", "interval-line");
      line.style.left = cssPercent(system.primary.interval_low);
      line.style.width = cssPercent(system.primary.interval_high - system.primary.interval_low);
      const point = element("span", "interval-point");
      point.style.left = cssPercent(system.primary.estimate);
      interval.append(line, point);

      const labels = element("div", "interval-label");
      labels.append(
        element("span", "", percent(system.primary.interval_low, 1)),
        element("span", "", `${system.primary.interval_method}`),
        element("span", "", percent(system.primary.interval_high, 1)),
      );

      const accounting = element("p", "accounting-line");
      const parts = [
        ["planned", system.planned],
        [
          "started sensitivity",
          system.started === 0
            ? "not applicable"
            : percent(system.primary.started_sensitivity ?? system.accepted / system.started, 1),
        ],
        ["completed", system.completed],
        ["quality failed", system.quality_failed],
        ["abstained", system.abstained],
        ["generation failed", system.generation_failed ?? 0],
        ["budget exceeded", system.budget_exceeded ?? 0],
        ["budget unverifiable", system.budget_unverifiable ?? 0],
        ["infrastructure", system.infrastructure_failed],
        ["not started", system.not_started ?? 0],
      ];
      for (const [label, value] of parts) {
        const span = element("span");
        span.append(element("strong", "", String(value)), document.createTextNode(` ${label}`));
        accounting.append(span);
      }

      card.append(header, estimateRow, interval, labels, accounting);
      return card;
    }),
  );
}

function renderStageList(container, stages, total) {
  container.replaceChildren(
    ...stages.map((stage) => {
      const row = element("div", "funnel-row");
      const track = element("div", "funnel-track");
      const fill = element("div", "funnel-fill");
      setColor(fill, "--fill", stage.color);
      const ratio = total === 0 ? null : stage.count / total;
      fill.style.width = ratio === null ? "0%" : cssPercent(ratio);
      track.append(fill);
      row.append(
        element("span", "", stage.label),
        track,
        element(
          "strong",
          "funnel-value",
          ratio === null ? `${stage.count} · not applicable` : `${stage.count} · ${percent(ratio)}`,
        ),
      );
      return row;
    }),
  );
}

function renderAttemptAccounting(release) {
  const total = release.scope.planned_attempts;
  document.querySelector("#attempt-total").textContent = `${total} planned attempts`;
  renderStageList(document.querySelector("#execution-coverage"), release.execution_coverage, total);
  renderStageList(document.querySelector("#final-dispositions"), release.final_dispositions, total);
  document
    .querySelector("#limitations-list")
    .replaceChildren(...release.limitations.map((item) => element("li", "", item)));
}

function caseRate(caseItem, systemId) {
  const result = caseItem.systems[systemId];
  return result.denominator === 0 ? null : result.accepted / result.denominator;
}

function renderComparison(release) {
  const contrast = release.primary_contrast;
  const section = document.querySelector("#compare");
  if (!contrast) {
    section.hidden = true;
    for (const anchor of document.querySelectorAll("[data-compare-link]")) {
      anchor.hidden = true;
    }
    return;
  }
  section.hidden = false;
  for (const anchor of document.querySelectorAll("[data-compare-link]")) {
    anchor.hidden = false;
  }
  const systemA = release.systems.find((system) => system.id === contrast.system_a);
  const systemB = release.systems.find((system) => system.id === contrast.system_b);
  if (!systemA || !systemB) throw new Error("Primary contrast references an unknown system");

  const summary = document.querySelector("#comparison-summary");
  const estimateWrap = element("div");
  estimateWrap.append(
    element("p", "kicker", `${systemA.name} minus ${systemB.name}`),
    element("div", "contrast-estimate", signedPoints(contrast.estimate)),
    element(
      "p",
      "case-id",
      `${signedPoints(contrast.interval_low)} to ${signedPoints(contrast.interval_high)} · ${contrast.method}`,
    ),
  );
  summary.replaceChildren(estimateWrap, element("p", "contrast-note", contrast.note));

  const plot = document.querySelector("#paired-plot");
  const legend = element("div", "plot-legend");
  for (const system of [systemA, systemB]) {
    const item = element("span", "system-symbol", system.name);
    applySystemStyle(item, system);
    legend.append(item);
  }
  const axisLabels = element("div", "paired-axis-labels");
  axisLabels.append(
    element("span", "", "0%"),
    element("span", "", "25%"),
    element("span", "", "50%"),
    element("span", "", "75%"),
    element("span", "", "100%"),
  );

  const rows = release.cases.map((caseItem) => {
    const rateA = caseRate(caseItem, systemA.id);
    const rateB = caseRate(caseItem, systemB.id);
    const row = element("div", "paired-row");
    const axis = element("div", "paired-axis");
    const connector = element("span", "paired-connector");
    if (rateA === null || rateB === null) {
      return null;
    }
    connector.style.left = cssPercent(Math.min(rateA, rateB));
    connector.style.width = cssPercent(Math.abs(rateA - rateB));
    const pointA = element("span", "paired-point");
    pointA.style.left = cssPercent(rateA);
    setColor(pointA, "--point-color", systemA.color);
    const pointB = element("span", "paired-point");
    pointB.style.left = cssPercent(rateB);
    setColor(pointB, "--point-color", systemB.color);
    pointB.style.setProperty("--point-radius", systemB.symbol === "square" ? "2px" : "50%");
    axis.append(connector, pointA, pointB);
    row.append(element("span", "paired-case", caseItem.title), axis);
    return row;
  });
  plot.setAttribute(
    "aria-label",
    `Paired strict acceptance for ${systemA.name} and ${systemB.name} across ${release.cases.length} cases`,
  );
  plot.replaceChildren(legend, axisLabels, ...rows.filter(Boolean));

  document.querySelector("#paired-system-a").textContent = systemA.name;
  document.querySelector("#paired-system-b").textContent = systemB.name;
  document.querySelector("#paired-table-body").replaceChildren(
    ...release.cases.map((caseItem) => {
      const rateA = caseRate(caseItem, systemA.id);
      const rateB = caseRate(caseItem, systemB.id);
      const row = element("tr");
      row.append(
        element("th", "", caseItem.title),
        element("td", "", percent(rateA)),
        element("td", "", percent(rateB)),
        element(
          "td",
          "",
          rateA === null || rateB === null ? "not applicable" : signedPoints(rateA - rateB),
        ),
      );
      row.firstElementChild.scope = "row";
      return row;
    }),
  );
}

function caseClassification(caseItem) {
  const results = Object.values(caseItem.systems);
  const denominator = results.reduce((total, result) => total + result.denominator, 0);
  const accepted = results.reduce((total, result) => total + result.accepted, 0);
  if (denominator === 0) return "unobserved";
  if (accepted === denominator) return "accepted";
  if (accepted === 0) return "no-acceptance";
  return "mixed";
}

function resultLabel(result) {
  if (result.denominator === 0) return "no recorded attempts";
  const dispositions = [];
  if (result.quality_failed) dispositions.push(`${result.quality_failed} quality failed`);
  if (result.abstained) dispositions.push(`${result.abstained} abstained`);
  if (result.generation_failed) {
    dispositions.push(`${result.generation_failed} generation failed`);
  }
  if (result.budget_exceeded) {
    dispositions.push(`${result.budget_exceeded} budget exceeded`);
  }
  if (result.budget_unverifiable) {
    dispositions.push(`${result.budget_unverifiable} budget unverifiable`);
  }
  if (result.infrastructure_failed) {
    dispositions.push(`${result.infrastructure_failed} infrastructure failed`);
  }
  if (result.not_started) dispositions.push(`${result.not_started} not started`);
  return dispositions.length ? dispositions.join(" · ") : "all planned attempts accepted";
}

function updateQuery() {
  const parameters = new URLSearchParams(window.location.search);
  if (state.search) parameters.set("q", state.search);
  else parameters.delete("q");
  if (state.outcome !== "all") parameters.set("outcome", state.outcome);
  else parameters.delete("outcome");
  history.replaceState(
    null,
    "",
    `${window.location.pathname}?${parameters}${window.location.hash}`,
  );
}

function renderCases() {
  const release = state.release;
  const query = state.search.trim().toLocaleLowerCase();
  const visible = release.cases.filter((caseItem) => {
    const haystack = [caseItem.id, caseItem.title, ...caseItem.tags].join(" ").toLocaleLowerCase();
    return (
      (!query || haystack.includes(query)) &&
      (state.outcome === "all" || caseClassification(caseItem) === state.outcome)
    );
  });
  document.querySelector("#case-count").textContent =
    `${visible.length} of ${release.cases.length} cases`;
  const list = document.querySelector("#case-list");
  if (visible.length === 0) {
    list.replaceChildren(element("div", "empty-state", "No cases match these filters."));
    return;
  }

  list.replaceChildren(
    ...visible.map((caseItem) => {
      const row = element("article", "case-row");
      if (!Number.isSafeInteger(release.systems.length) || release.systems.length < 1) {
        throw new Error("Release must contain at least one system");
      }
      row.style.setProperty("--system-count", String(release.systems.length));
      const identity = element("div");
      identity.append(
        element("div", "case-title", caseItem.title),
        element("div", "case-id", caseItem.id),
        element("div", "case-tags", caseItem.tags.join(" · ")),
      );
      row.append(identity);
      for (const system of release.systems) {
        const result = caseItem.systems[system.id];
        const wrapper = element("div", "case-result");
        const symbol = element("span", "mini-symbol");
        applySystemStyle(symbol, system);
        const copy = element("div");
        copy.append(
          element(
            "strong",
            "",
            `${system.name}: ${result.accepted}/${result.denominator} accepted`,
          ),
          element("span", "", resultLabel(result)),
        );
        wrapper.append(symbol, copy);
        row.append(wrapper);
      }
      const button = element("button", "open-case", "Inspect evidence");
      button.type = "button";
      button.dataset.caseId = caseItem.id;
      row.append(button);
      return row;
    }),
  );
}

function gateColor(status) {
  if (status === "passed") return "#12664f";
  if (status === "failed") return "#b64a5a";
  if (status === "mixed") return "#d57a2a";
  return "#8a938f";
}

function openCase(caseId, opener = document.activeElement) {
  const caseItem = state.release.cases.find((candidate) => candidate.id === caseId);
  if (!caseItem) return;
  state.dialogOpener = opener instanceof HTMLElement ? opener : null;
  document.querySelector("#dialog-title").textContent = caseItem.title;
  const content = document.querySelector("#dialog-content");
  const brief = element("div", "brief-box", caseItem.brief);

  const outcomes = element("section", "dialog-section");
  outcomes.append(element("h3", "", "Attempt dispositions"));
  const tableWrap = element("div", "table-scroll");
  tableWrap.tabIndex = 0;
  tableWrap.setAttribute("role", "region");
  tableWrap.setAttribute("aria-label", "Scrollable attempt dispositions");
  const table = element("table");
  const header = element("thead");
  const headerRow = element("tr");
  for (const label of [
    "System",
    "Accepted",
    "Quality failed",
    "Abstained",
    "Generation failed",
    "Budget exceeded",
    "Budget unverifiable",
    "Infrastructure",
    "Not started",
  ]) {
    headerRow.append(element("th", "", label));
  }
  header.append(headerRow);
  const body = element("tbody");
  for (const system of state.release.systems) {
    const result = caseItem.systems[system.id];
    const row = element("tr");
    const scope = element("th", "", system.name);
    scope.scope = "row";
    row.append(
      scope,
      element("td", "", `${result.accepted}/${result.denominator}`),
      element("td", "", String(result.quality_failed)),
      element("td", "", String(result.abstained)),
      element("td", "", String(result.generation_failed ?? 0)),
      element("td", "", String(result.budget_exceeded ?? 0)),
      element("td", "", String(result.budget_unverifiable ?? 0)),
      element("td", "", String(result.infrastructure_failed)),
      element("td", "", String(result.not_started ?? 0)),
    );
    body.append(row);
  }
  table.append(header, body);
  tableWrap.append(table);
  outcomes.append(tableWrap);

  const gates = element("section", "dialog-section");
  gates.append(element("h3", "", "Independent verifier gates"));
  const gateList = element("div", "gate-list");
  for (const [name, status] of Object.entries(caseItem.gates)) {
    const gate = element("div", "gate", `${name}: ${statusLabel(status)}`);
    setColor(gate, "--gate-color", gateColor(status));
    gateList.append(gate);
  }
  gates.append(gateList);

  const evidence = element("section", "dialog-section");
  evidence.append(
    element("h3", "", "Evidence availability"),
    element("p", "evidence-note", caseItem.evidence_status),
  );
  content.replaceChildren(brief, outcomes, gates, evidence);

  const parameters = new URLSearchParams(window.location.search);
  parameters.set("case", caseId);
  history.replaceState(
    null,
    "",
    `${window.location.pathname}?${parameters}${window.location.hash}`,
  );
  const dialog = document.querySelector("#case-dialog");
  dialog.showModal();
  dialog.querySelector("#dialog-title").focus();
}

function closeCase() {
  const dialog = document.querySelector("#case-dialog");
  if (dialog.open) dialog.close();
  const parameters = new URLSearchParams(window.location.search);
  parameters.delete("case");
  history.replaceState(
    null,
    "",
    `${window.location.pathname}?${parameters}${window.location.hash}`,
  );
}

function metricValidationLabel(validation) {
  if (typeof validation === "string") return validation;
  if (!validation || typeof validation !== "object") return "not declared";
  const parts = [validation.status, validation.method].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (Array.isArray(validation.evidence)) {
    parts.push(
      `${validation.evidence.length} evidence record${validation.evidence.length === 1 ? "" : "s"}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "not declared";
}

function renderMetrics(release) {
  document.querySelector("#metric-grid").replaceChildren(
    ...release.metrics.map((metric) => {
      const card = element("article", "metric-card");
      const body = element("div");
      body.append(
        element("span", "metric-tier", metric.tier),
        element("h3", "", metric.name),
        element("p", "metric-description", metric.construct),
        element(
          "p",
          "metric-meta",
          `Unit: ${metric.unit} · Population: ${metric.population} · Denominator: ${metric.denominator}`,
        ),
        element(
          "p",
          "metric-meta",
          `Version: ${metric.version ?? "not declared"} · Value type: ${metric.value_type ?? "not declared"}`,
        ),
        element(
          "p",
          "metric-meta",
          `Implementation: ${metric.implementation} · Validation: ${metricValidationLabel(metric.validation)}`,
        ),
        element("p", "metric-meta", `Limitation: ${metric.limitations}`),
      );
      card.append(body, element("span", "metric-direction", metric.direction));
      return card;
    }),
  );
}

function renderProvenance(release) {
  const list = document.querySelector("#provenance-list");
  list.replaceChildren(
    ...Object.entries(release.provenance).map(([key, value]) => {
      const row = element("div");
      row.append(element("dt", "", key.replaceAll("_", " ")), element("dd", "", String(value)));
      return row;
    }),
  );

  const downloads = document.querySelector("#download-list");
  downloads.replaceChildren(
    ...release.downloads.map((download) => {
      const link = element("a", "download-item");
      link.href = relativeDownloadUrl(download.path);
      link.setAttribute("download", "");
      const copy = element("span");
      copy.append(element("strong", "", download.label), element("span", "", download.description));
      link.append(copy, element("span", "", "Download ↓"));
      return link;
    }),
  );

  for (const anchor of document.querySelectorAll("[data-download]")) {
    const download = release.downloads.find((item) => item.id === anchor.dataset.download);
    if (download) anchor.href = relativeDownloadUrl(download.path);
  }
}

function bindInteractions() {
  const search = document.querySelector("#case-search");
  const outcome = document.querySelector("#outcome-filter");
  search.value = state.search;
  outcome.value = ["all", "mixed", "accepted", "no-acceptance", "unobserved"].includes(
    state.outcome,
  )
    ? state.outcome
    : "all";
  state.outcome = outcome.value;

  search.addEventListener("input", () => {
    state.search = search.value;
    updateQuery();
    renderCases();
  });
  outcome.addEventListener("change", () => {
    state.outcome = outcome.value;
    updateQuery();
    renderCases();
  });
  document.querySelector("#case-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-case-id]");
    if (button) openCase(button.dataset.caseId, button);
  });
  document.querySelector("[data-close-dialog]").addEventListener("click", closeCase);
  document.querySelector("#case-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeCase();
  });
  document.querySelector("#case-dialog").addEventListener("close", () => {
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.has("case")) {
      parameters.delete("case");
      history.replaceState(
        null,
        "",
        `${window.location.pathname}?${parameters}${window.location.hash}`,
      );
    }
    if (state.dialogOpener && document.contains(state.dialogOpener)) {
      state.dialogOpener.focus();
    }
    state.dialogOpener = null;
  });
}

function render(release) {
  renderReleaseIdentity(release);
  renderSystems(release);
  renderAttemptAccounting(release);
  renderComparison(release);
  renderCases();
  renderMetrics(release);
  renderProvenance(release);
  bindInteractions();

  const requestedCase = new URLSearchParams(window.location.search).get("case");
  if (requestedCase) openCase(requestedCase);
}

async function main() {
  try {
    const catalog = await fetchJson(CATALOG_URL);
    if (!Array.isArray(catalog.releases) || catalog.releases.length === 0) {
      throw new Error("Release catalog is empty");
    }
    if (
      typeof catalog.default_release_id !== "string" ||
      !catalog.releases.every(
        (release) =>
          typeof release.id === "string" &&
          typeof release.manifest === "string" &&
          isSafeRelativePath(release.manifest),
      )
    ) {
      throw new Error("Release catalog has an invalid versioned release reference");
    }
    const selectedId = new URLSearchParams(window.location.search).get("release");
    const selected =
      catalog.releases.find((release) => release.id === selectedId) ??
      catalog.releases.find((release) => release.id === catalog.default_release_id);
    if (!selected) throw new Error("Release catalog has no valid default_release_id");
    state.releaseUrl = new URL(selected.manifest, new URL(CATALOG_URL, window.location.href)).href;
    state.release = await fetchJson(state.releaseUrl);
    render(state.release);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const toast = document.querySelector("#error-toast");
    toast.textContent = `The release could not be displayed: ${message}`;
    toast.hidden = false;
    document.querySelector("#release-summary").textContent =
      "The versioned release data could not be loaded. Serve the site over HTTP and try again.";
  }
}

await main();
