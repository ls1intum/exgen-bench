const CATALOG_URL = "./data/catalog.json";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PUBLIC_PATH =
  /^\.\/(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/;
const PROVIDERS = {
  alibaba: { label: "Alibaba Cloud", icon: "alibabacloud.svg" },
  "alibaba cloud": { label: "Alibaba Cloud", icon: "alibabacloud.svg" },
  anthropic: { label: "Anthropic", icon: "anthropic.svg" },
  deepseek: { label: "DeepSeek", icon: "deepseek.svg" },
  google: { label: "Google", icon: "googlegemini.svg" },
  "google deepmind": { label: "Google DeepMind", icon: "googlegemini.svg" },
  meta: { label: "Meta", icon: "meta.svg" },
  mistral: { label: "Mistral AI", icon: "mistralai.svg" },
  "mistral ai": { label: "Mistral AI", icon: "mistralai.svg" },
  qwen: { label: "Alibaba Cloud", icon: "alibabacloud.svg" },
};

const state = {
  release: null,
  releaseUrl: null,
  search: new URLSearchParams(window.location.search).get("q") ?? "",
  approach: new URLSearchParams(window.location.search).get("approach") ?? "all",
  model: new URLSearchParams(window.location.search).get("model") ?? "all",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function percent(value, digits = 0) {
  if (value === null || value === undefined) return "n/a";
  if (!Number.isFinite(value)) throw new Error("Expected a finite rate");
  return new Intl.NumberFormat("en", {
    style: "percent",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function signedPoints(value) {
  const points = value * 100;
  return `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pp`;
}

function factorText(system, key) {
  const value = system.factors[key];
  return value === undefined || value === null ? null : String(value);
}

function providerMetadata(system) {
  const provider = factorText(system, "provider");
  if (!provider) return null;
  return PROVIDERS[provider.trim().toLocaleLowerCase()] ?? { label: provider, icon: null };
}

function validColor(value) {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    throw new Error("Expected a six-digit hexadecimal color");
  }
  return value;
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

function appendDefinition(list, term, description) {
  const row = element("div");
  row.append(element("dt", "", term), element("dd", "", String(description)));
  list.append(row);
}

function renderReleaseHeader(release) {
  document.title = `${release.title} · exgen-bench`;
  document.querySelector("#release-title").textContent = release.title;
  document.querySelector("#release-summary").textContent = release.summary;
  document.querySelector("#release-notice").textContent = release.notice;
  document.querySelector("#footer-release").textContent =
    `${release.release_id} · ${release.release_version}`;

  const metadata = document.querySelector("#release-meta");
  const values = [
    ["Release", `${release.release_id} ${release.release_version}`],
    ["Published", release.published_at],
    ["Dataset", release.scope.dataset],
    ["Target", release.scope.target],
    ["Briefs", release.scope.cases],
    ["Systems", release.scope.systems],
    ["Attempts", release.scope.planned_attempts],
  ];
  metadata.replaceChildren();
  for (const [term, value] of values) appendDefinition(metadata, term, value);

  document.querySelector("[data-demo-notice]").hidden = release.status !== "illustrative";
}

function accounting(system) {
  return [
    ["quality failed", system.quality_failed],
    ["abstained", system.abstained],
    ["generation failed", system.generation_failed ?? 0],
    ["budget exceeded", system.budget_exceeded ?? 0],
    ["budget unverifiable", system.budget_unverifiable ?? 0],
    ["infrastructure failed", system.infrastructure_failed],
    ["not started", system.not_started ?? 0],
  ]
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
}

function renderResults() {
  const systems = visibleSystems();
  const list = document.querySelector("#result-list");
  const method = state.release.systems[0]?.primary.interval_method;
  document.querySelector("#result-method").textContent =
    `Strict acceptance across all planned attempts${method ? ` · ${method}.` : "."}`;
  list.replaceChildren(
    ...systems.map((system) => {
      const row = element("article", "result-row");
      row.style.setProperty("--system-color", validColor(system.color));

      const identity = element("div", "result-identity");
      const provider = providerMetadata(system);
      const mark = element("span", "provider-mark");
      if (provider?.icon) {
        const image = element("img");
        image.src = `./assets/providers/${provider.icon}`;
        image.alt = "";
        mark.append(image);
      } else {
        mark.textContent = (provider?.label ?? system.name).slice(0, 2).toLocaleUpperCase();
      }
      const label = element("div");
      const factors = [
        factorText(system, "model"),
        factorText(system, "approach"),
        provider?.label,
      ].filter(Boolean);
      label.append(
        element("h3", "", system.name),
        element("p", "", factors.length > 0 ? factors.join(" · ") : system.description),
      );
      identity.append(mark, label);

      const estimate = element("div", "result-estimate");
      estimate.append(
        element("strong", "", percent(system.primary.estimate, 1)),
        element("span", "", `${system.primary.numerator}/${system.primary.denominator} accepted`),
      );

      const interval = element("div", "interval");
      const track = element("div", "interval-track");
      const range = element("span", "interval-range");
      range.style.left = `${system.primary.interval_low * 100}%`;
      range.style.width = `${(system.primary.interval_high - system.primary.interval_low) * 100}%`;
      const point = element("span", "interval-point");
      point.style.left = `${system.primary.estimate * 100}%`;
      track.append(range, point);
      const labels = element("div", "interval-labels");
      labels.append(
        element("span", "", "0%"),
        element(
          "span",
          "",
          `${percent(system.primary.interval_low, 1)}–${percent(system.primary.interval_high, 1)}`,
        ),
        element("span", "", "100%"),
      );
      interval.append(track, labels);

      const details = element("p", "result-accounting");
      const nonAccepted = accounting(system);
      details.textContent =
        `${system.completed}/${system.planned} completed` +
        (nonAccepted ? ` · ${nonAccepted}` : "");

      row.append(identity, estimate, interval, details);
      return row;
    }),
  );
  if (systems.length === 0) {
    list.replaceChildren(element("p", "empty-state", "No systems match these filters."));
  }
}

function renderContrast(release) {
  const contrast = release.primary_contrast;
  const container = document.querySelector("#contrast");
  const systems = new Set(visibleSystems().map((system) => system.id));
  if (!contrast || !systems.has(contrast.system_a) || !systems.has(contrast.system_b)) {
    container.hidden = true;
    return;
  }
  const systemA = release.systems.find((system) => system.id === contrast.system_a);
  const systemB = release.systems.find((system) => system.id === contrast.system_b);
  if (!systemA || !systemB) throw new Error("Primary contrast references an unknown system");

  container.hidden = false;
  container.replaceChildren(
    element("strong", "", `${systemA.name} − ${systemB.name}: ${signedPoints(contrast.estimate)}`),
    element(
      "span",
      "",
      `${signedPoints(contrast.interval_low)} to ${signedPoints(contrast.interval_high)} · ${contrast.method}`,
    ),
    element("p", "", contrast.note),
  );
}

function resultDescription(result) {
  const parts = [];
  if (result.quality_failed) parts.push(`${result.quality_failed} quality failed`);
  if (result.abstained) parts.push(`${result.abstained} abstained`);
  if (result.generation_failed) parts.push(`${result.generation_failed} generation failed`);
  if (result.budget_exceeded) parts.push(`${result.budget_exceeded} over budget`);
  if (result.budget_unverifiable) parts.push(`${result.budget_unverifiable} budget unknown`);
  if (result.infrastructure_failed) parts.push(`${result.infrastructure_failed} infrastructure`);
  if (result.not_started) parts.push(`${result.not_started} not started`);
  return parts.join(", ") || "all accepted";
}

function renderCaseHeader() {
  const row = element("tr");
  const caseHeading = element("th", "", "Brief");
  caseHeading.scope = "col";
  row.append(caseHeading);
  for (const system of visibleSystems()) {
    const heading = element("th", "", system.name);
    heading.scope = "col";
    row.append(heading);
  }
  document.querySelector("#case-table-head").replaceChildren(row);
}

function updateQuery() {
  const parameters = new URLSearchParams(window.location.search);
  if (state.search) parameters.set("q", state.search);
  else parameters.delete("q");
  if (state.approach !== "all") parameters.set("approach", state.approach);
  else parameters.delete("approach");
  if (state.model !== "all") parameters.set("model", state.model);
  else parameters.delete("model");
  const query = parameters.toString();
  history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

function visibleSystems() {
  return state.release.systems.filter(
    (system) =>
      (state.approach === "all" || factorText(system, "approach") === state.approach) &&
      (state.model === "all" || factorText(system, "model") === state.model),
  );
}

function renderCases() {
  const query = state.search.trim().toLocaleLowerCase();
  const cases = state.release.cases.filter((caseItem) =>
    [caseItem.id, caseItem.title, caseItem.brief, ...caseItem.tags]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );

  const body = document.querySelector("#case-table-body");
  body.replaceChildren(
    ...cases.map((caseItem) => {
      const row = element("tr");
      const identity = element("th", "case-identity");
      identity.scope = "row";
      identity.append(
        element("strong", "", caseItem.title),
        element("span", "", caseItem.brief),
        element("small", "", caseItem.tags.join(" · ")),
      );
      row.append(identity);

      for (const system of visibleSystems()) {
        const result = caseItem.systems[system.id];
        const cell = element("td", "case-result");
        const value = result.denominator === 0 ? "n/a" : `${result.accepted}/${result.denominator}`;
        cell.append(element("strong", "", value), element("span", "", resultDescription(result)));
        row.append(cell);
      }
      return row;
    }),
  );
  document.querySelector("#case-count").textContent =
    `${cases.length} of ${state.release.cases.length} briefs`;
}

function metricSummary(metric) {
  return `${metric.construct} Denominator: ${metric.denominator}. Limitation: ${metric.limitations}`;
}

function renderDetails(release) {
  const methods = document.querySelector("#method-list");
  methods.replaceChildren();
  for (const metric of release.metrics) {
    appendDefinition(methods, `${metric.name} (${metric.tier})`, metricSummary(metric));
  }

  document
    .querySelector("#limitations-list")
    .replaceChildren(...release.limitations.map((item) => element("li", "", item)));

  const provenance = document.querySelector("#provenance-list");
  provenance.replaceChildren();
  for (const [key, value] of Object.entries(release.provenance)) {
    appendDefinition(provenance, key.replaceAll("_", " "), value);
  }

  const downloads = document.querySelector("#download-list");
  downloads.replaceChildren(
    ...release.downloads.map((download) => {
      const link = element("a", "file-link");
      link.href = relativeDownloadUrl(download.path);
      link.setAttribute("download", "");
      link.append(element("strong", "", download.label), element("span", "", download.description));
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
  search.value = state.search;
  search.addEventListener("input", () => {
    state.search = search.value;
    updateQuery();
    renderCases();
  });

  const dimensions = [
    ["approach", document.querySelector("#approach-filter")],
    ["model", document.querySelector("#model-filter")],
  ];
  let filtersVisible = false;
  for (const [dimension, select] of dimensions) {
    const values = [
      ...new Set(
        state.release.systems
          .map((system) => factorText(system, dimension))
          .filter((value) => value !== null),
      ),
    ].sort();
    select.replaceChildren(
      element("option", "", `All ${dimension === "approach" ? "approaches" : "models"}`),
      ...values.map((value) => {
        const option = element("option", "", value);
        option.value = value;
        return option;
      }),
    );
    select.firstElementChild.value = "all";
    if (!["all", ...values].includes(state[dimension])) state[dimension] = "all";
    select.value = state[dimension];
    select.closest("label").hidden = values.length < 2;
    filtersVisible ||= values.length > 1;
    select.addEventListener("change", () => {
      state[dimension] = select.value;
      updateQuery();
      renderResults();
      renderContrast(state.release);
      renderCaseHeader();
      renderCases();
    });
  }
  document.querySelector("#result-filters").hidden = !filtersVisible;
}

function render(release) {
  renderReleaseHeader(release);
  renderResults();
  renderContrast(release);
  renderCaseHeader();
  renderCases();
  renderDetails(release);
  bindInteractions();
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
    const requested = new URLSearchParams(window.location.search).get("release");
    const selected =
      catalog.releases.find((release) => release.id === requested) ??
      catalog.releases.find((release) => release.id === catalog.default_release_id);
    if (!selected) throw new Error("Release catalog has no valid default release");

    state.releaseUrl = new URL(selected.manifest, new URL(CATALOG_URL, window.location.href)).href;
    state.release = await fetchJson(state.releaseUrl);
    render(state.release);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const alert = document.querySelector("#error-message");
    alert.textContent = `The release could not be displayed: ${message}`;
    alert.hidden = false;
    document.querySelector("#release-title").textContent = "Release unavailable";
  }
}

await main();
