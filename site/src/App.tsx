import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { MetricChart, ValueChart } from "./charts.tsx";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type Configuration,
  type PublicCase,
  type PublicSystem,
  configuration,
  dollars,
  loadRelease,
  percent,
  seconds,
} from "./release.ts";
import type { PublicRelease } from "../contracts.ts";

type View = "value" | "quality" | "cost" | "speed";

const VIEWS = new Set<View>(["value", "quality", "cost", "speed"]);

function queryView(fallback: View): View {
  const value = new URLSearchParams(window.location.search).get("view") as View | null;
  return value && VIEWS.has(value) ? value : fallback;
}

export default function App() {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadRelease>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRelease()
      .then(setLoaded)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load this release.");
      });
  }, []);

  if (error) return <ErrorPage message={error} />;
  if (!loaded) return <LoadingPage />;
  return <Dashboard release={loaded.release} releaseUrl={loaded.releaseUrl} />;
}

function Dashboard({ release, releaseUrl }: { release: PublicRelease; releaseUrl: URL }) {
  const configurations = useMemo(() => release.systems.map(configuration), [release.systems]);
  const allProviders = useMemo(
    () =>
      [...new Map(configurations.map((item) => [item.provider.id, item.provider])).values()].sort(
        (left, right) => left.name.localeCompare(right.name),
      ),
    [configurations],
  );
  const allApproaches = useMemo(
    () => [...new Set(configurations.map((item) => item.approach))].sort(),
    [configurations],
  );
  const [view, setView] = useState<View>(() =>
    queryView(
      configurations.some((item) => item.system.decision_metrics?.cost) ? "value" : "quality",
    ),
  );
  const [providers, setProviders] = useState(() => new Set(allProviders.map((item) => item.id)));
  const [approaches, setApproaches] = useState(() => new Set(allApproaches));

  const visible = configurations.filter(
    (item) => providers.has(item.provider.id) && approaches.has(item.approach),
  );
  const filtered = visible.length !== configurations.length;

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (view === "value") parameters.delete("view");
    else parameters.set("view", view);
    history.replaceState(null, "", `${window.location.pathname}?${parameters.toString()}`);
  }, [view]);

  const resetFilters = () => {
    setProviders(new Set(allProviders.map((item) => item.id)));
    setApproaches(new Set(allApproaches));
  };

  return (
    <>
      <header className="topbar">
        <a className="brand" href="./" aria-label="exgen-bench home">
          <span className="brand-mark">ex</span>
          <span>exgen-bench</span>
        </a>
        <nav aria-label="Project links">
          <a href="#results">Results</a>
          <a href={downloadUrl(release, releaseUrl, "attempts_csv")}>Data</a>
          <a href="https://github.com/ls1intum/exgen-bench/blob/main/docs/METHODOLOGY.md">Method</a>
          <a href="https://github.com/ls1intum/exgen-bench">GitHub</a>
        </nav>
      </header>

      {release.status === "illustrative" && (
        <div className="illustrative-banner" role="note">
          <span>Illustrative data</span>
          <p>Every model, cost, and result on this page is synthetic.</p>
        </div>
      )}

      <main id="main-content">
        <section className="release-intro" aria-labelledby="release-title">
          <div>
            <div className="eyebrow">
              <span className="status-dot" />
              {release.release_id} · {release.release_version}
            </div>
            <h1 id="release-title">{release.title}</h1>
            <p>{release.summary}</p>
          </div>
          <a
            className={buttonVariants({ className: "download-button" })}
            href={downloadUrl(release, releaseUrl, "attempts_csv")}
            download
          >
            <ArrowDownToLine data-icon="inline-start" />
            Download data
          </a>
        </section>

        <dl className="release-stats" aria-label="Release scope">
          <div>
            <dt>Configurations</dt>
            <dd>{release.scope.systems}</dd>
          </div>
          <div>
            <dt>Briefs</dt>
            <dd>{release.scope.cases}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{release.scope.planned_attempts}</dd>
          </div>
          <div>
            <dt>Primary endpoint</dt>
            <dd>Strict acceptance</dd>
          </div>
        </dl>

        <section id="results" className="results-shell" aria-label="Benchmark results">
          <Tabs value={view} onValueChange={(next) => setView(next as View)}>
            <div className="controls">
              <div className="tab-scroll">
                <TabsList aria-label="Result view">
                  <TabsTrigger value="value">Value</TabsTrigger>
                  <TabsTrigger value="quality">Quality</TabsTrigger>
                  <TabsTrigger value="cost">Cost</TabsTrigger>
                  <TabsTrigger value="speed">Speed</TabsTrigger>
                </TabsList>
              </div>
              <div className="filter-row">
                <FilterMenu
                  label="Approach"
                  values={allApproaches}
                  selected={approaches}
                  onChange={setApproaches}
                />
                <ProviderFilter
                  providers={allProviders}
                  selected={providers}
                  onChange={setProviders}
                />
                {filtered && (
                  <Button variant="ghost" size="sm" onClick={resetFilters}>
                    <RotateCcw data-icon="inline-start" />
                    Reset
                  </Button>
                )}
              </div>
            </div>

            <TabsContent value="value">
              <ValueChart configurations={visible} approaches={allApproaches} />
            </TabsContent>
            <TabsContent value="quality">
              <MetricChart configurations={visible} approaches={allApproaches} metric="quality" />
            </TabsContent>
            <TabsContent value="cost">
              <MetricChart configurations={visible} approaches={allApproaches} metric="cost" />
            </TabsContent>
            <TabsContent value="speed">
              <MetricChart configurations={visible} approaches={allApproaches} metric="latency" />
            </TabsContent>
            <ObservedHighlights configurations={visible} />
            <ConfigurationTable configurations={visible} view={view} />
          </Tabs>
        </section>

        <SecondaryDetails release={release} releaseUrl={releaseUrl} />
      </main>

      <footer>
        <span>exgen-bench</span>
        <span>
          {release.release_id} · Published {release.published_at} ·{" "}
          <a href="./LICENSE.txt">License</a> ·{" "}
          <a href="./third-party-licenses.txt">Third-party notices</a>
        </span>
      </footer>
    </>
  );
}

function FilterMenu({
  label,
  values,
  selected,
  onChange,
}: {
  label: string;
  values: string[];
  selected: Set<string>;
  onChange: (value: Set<string>) => void;
}) {
  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        {label} <span className="filter-count">{selected.size}</span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {values.map((value) => (
            <DropdownMenuCheckboxItem
              key={value}
              checked={selected.has(value)}
              onCheckedChange={() => toggle(value)}
              closeOnClick={false}
            >
              {value}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderFilter({
  providers,
  selected,
  onChange,
}: {
  providers: Configuration["provider"][];
  selected: Set<string>;
  onChange: (value: Set<string>) => void;
}) {
  const toggle = (providerId: string) => {
    const next = new Set(selected);
    if (next.has(providerId)) next.delete(providerId);
    else next.add(providerId);
    onChange(next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        Providers <span className="filter-count">{selected.size}</span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Providers</DropdownMenuLabel>
          {providers.map((provider) => (
            <DropdownMenuCheckboxItem
              key={provider.id}
              checked={selected.has(provider.id)}
              onCheckedChange={() => toggle(provider.id)}
              closeOnClick={false}
            >
              <ProviderIcon provider={provider} />
              {provider.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ObservedHighlights({ configurations }: { configurations: Configuration[] }) {
  if (configurations.length === 0) return null;
  const withCost = configurations.flatMap((configuration) => {
    const cost = configuration.system.decision_metrics?.cost;
    return cost ? [{ configuration, estimate: cost.estimate }] : [];
  });
  const withLatency = configurations.flatMap((configuration) => {
    const latency = configuration.system.decision_metrics?.latency;
    return latency ? [{ configuration, estimate: latency.estimate }] : [];
  });
  const highestQualityEstimate = Math.max(
    ...configurations.map((item) => item.system.primary.estimate),
  );
  const highestQuality = configurations.filter(
    (item) => item.system.primary.estimate === highestQualityEstimate,
  );
  const lowestCostEstimate =
    withCost.length > 0 ? Math.min(...withCost.map((item) => item.estimate)) : null;
  const lowestCost = withCost.filter((item) => item.estimate === lowestCostEstimate);
  const fastestEstimate =
    withLatency.length > 0 ? Math.min(...withLatency.map((item) => item.estimate)) : null;
  const fastest = withLatency.filter((item) => item.estimate === fastestEstimate);

  return (
    <div className="highlights">
      <Highlight
        icon={<ShieldCheck />}
        label={
          highestQuality.length > 1
            ? "Highest observed acceptance · tie"
            : "Highest observed acceptance"
        }
        detail={highlightDetail(highestQuality)}
        value={percent(highestQualityEstimate, 1)}
      />
      {lowestCostEstimate !== null && (
        <Highlight
          icon={<CircleDollarSign />}
          label={lowestCost.length > 1 ? "Lowest observed cost · tie" : "Lowest observed cost"}
          detail={highlightDetail(lowestCost.map((item) => item.configuration))}
          value={dollars(lowestCostEstimate)}
        />
      )}
      {fastestEstimate !== null && (
        <Highlight
          icon={<Clock3 />}
          label={fastest.length > 1 ? "Fastest observed median · tie" : "Fastest observed median"}
          detail={highlightDetail(fastest.map((item) => item.configuration))}
          value={seconds(fastestEstimate)}
        />
      )}
    </div>
  );
}

function Highlight({
  icon,
  label,
  detail,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  value: string;
}) {
  return (
    <article>
      <span className="highlight-icon">{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function highlightDetail(configurations: Configuration[]): string {
  const first = configurations[0];
  return configurations.length === 1 && first
    ? `${first.model} · ${first.approach}`
    : `${configurations.length} configurations`;
}

function ConfigurationTable({
  configurations,
  view,
}: {
  configurations: Configuration[];
  view: View;
}) {
  const [showAll, setShowAll] = useState(false);
  const ordered = [...configurations].sort((left, right) => {
    if (view === "cost") {
      return (
        (left.system.decision_metrics?.cost?.estimate ?? Number.POSITIVE_INFINITY) -
        (right.system.decision_metrics?.cost?.estimate ?? Number.POSITIVE_INFINITY)
      );
    }
    if (view === "speed") {
      return (
        (left.system.decision_metrics?.latency?.estimate ?? Number.POSITIVE_INFINITY) -
        (right.system.decision_metrics?.latency?.estimate ?? Number.POSITIVE_INFINITY)
      );
    }
    return right.system.primary.estimate - left.system.primary.estimate;
  });
  const shown = showAll ? ordered : ordered.slice(0, 6);
  return (
    <section className="comparison" aria-labelledby="comparison-title">
      <div className="section-heading">
        <div>
          <h2 id="comparison-title">Configurations</h2>
          <p>Observed estimates; overlapping intervals are not rank claims.</p>
        </div>
        <span>
          {shown.length} of {ordered.length} shown
        </span>
      </div>
      <div className="table-scroll configuration-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Approach</th>
              <th
                scope="col"
                aria-sort={view === "value" || view === "quality" ? "descending" : undefined}
              >
                Strict acceptance
              </th>
              <th scope="col" aria-sort={view === "cost" ? "ascending" : undefined}>
                Cost / attempt
              </th>
              <th scope="col" aria-sort={view === "speed" ? "ascending" : undefined}>
                Median latency
              </th>
              <th scope="col">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <ConfigurationRow key={item.system.id} configuration={item} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-configuration-list">
        {shown.map((item) => (
          <ConfigurationCard key={item.system.id} configuration={item} />
        ))}
      </div>
      {ordered.length > 6 && (
        <Button
          className="show-all-button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? "Show fewer" : `Show all ${ordered.length}`}
        </Button>
      )}
    </section>
  );
}

function ConfigurationRow({ configuration: item }: { configuration: Configuration }) {
  const { system } = item;
  const metrics = system.decision_metrics;
  return (
    <tr>
      <th scope="row">
        <span className="model-cell">
          <ProviderIcon provider={item.provider} />
          <span>
            <strong>{item.model}</strong>
            <small>{item.provider.name}</small>
          </span>
        </span>
      </th>
      <td>
        <span className="approach-badge">{item.approach}</span>
      </td>
      <td>
        <strong>{percent(system.primary.estimate, 1)}</strong>
        <small>
          {percent(system.primary.interval_low)}–{percent(system.primary.interval_high)}
        </small>
      </td>
      <td>{metrics?.cost ? dollars(metrics.cost.estimate) : "—"}</td>
      <td>{metrics?.latency ? seconds(metrics.latency.estimate) : "—"}</td>
      <td>{system.planned}</td>
    </tr>
  );
}

function ConfigurationCard({ configuration: item }: { configuration: Configuration }) {
  const metrics = item.system.decision_metrics;
  return (
    <article>
      <header>
        <span className="model-cell">
          <ProviderIcon provider={item.provider} />
          <span>
            <strong>{item.model}</strong>
            <small>{item.provider.name}</small>
          </span>
        </span>
        <span className="approach-badge">{item.approach}</span>
      </header>
      <dl>
        <div>
          <dt>Acceptance</dt>
          <dd>
            {percent(item.system.primary.estimate, 1)}
            <small>
              {percent(item.system.primary.interval_low)}–
              {percent(item.system.primary.interval_high)} · {item.system.primary.denominator}{" "}
              attempts
            </small>
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{metrics?.cost ? dollars(metrics.cost.estimate) : "—"}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{metrics?.latency ? seconds(metrics.latency.estimate) : "—"}</dd>
        </div>
      </dl>
    </article>
  );
}

function ProviderIcon({ provider }: { provider: Configuration["provider"] }) {
  return provider.mark ? (
    <span className="provider-icon">
      <img src={provider.mark} alt="" />
    </span>
  ) : (
    <span className="provider-icon provider-fallback">{provider.name.slice(0, 1)}</span>
  );
}

function SecondaryDetails({ release, releaseUrl }: { release: PublicRelease; releaseUrl: URL }) {
  return (
    <section className="secondary" aria-labelledby="details-title">
      <div className="section-heading">
        <div>
          <h2 id="details-title">Release detail</h2>
          <p>Brief-level outcomes, method, provenance, and frozen files.</p>
        </div>
      </div>
      <details>
        <summary>Results by brief</summary>
        <BriefTable cases={release.cases} systems={release.systems} />
      </details>
      <details>
        <summary>Method and limitations</summary>
        <div className="detail-content prose-detail">
          <p>{release.notice}</p>
          <ul>
            {release.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      </details>
      <details>
        <summary>Provenance and files</summary>
        <div className="detail-content detail-grid">
          <dl>
            {Object.entries(release.provenance).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll("_", " ")}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="file-list">
            {release.downloads.map((download) => (
              <a key={download.id} href={new URL(download.path, releaseUrl).href}>
                <span>
                  <strong>{download.label}</strong>
                  <small>{download.description}</small>
                </span>
                <ArrowDownToLine data-icon="inline-end" />
              </a>
            ))}
          </div>
        </div>
      </details>
    </section>
  );
}

function BriefTable({ cases, systems }: { cases: PublicCase[]; systems: PublicSystem[] }) {
  return (
    <div className="detail-content table-scroll brief-table">
      <table>
        <thead>
          <tr>
            <th scope="col">Brief</th>
            {systems.map((system) => (
              <th key={system.id} scope="col">
                {configuration(system).model} · {configuration(system).approach}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cases.map((caseItem) => (
            <tr key={caseItem.id}>
              <th scope="row">
                <strong>{caseItem.title}</strong>
                <small>{caseItem.tags.join(" · ")}</small>
              </th>
              {systems.map((system) => {
                const result = caseItem.systems[system.id];
                return (
                  <td key={system.id}>
                    {result ? `${result.accepted}/${result.denominator}` : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function downloadUrl(release: PublicRelease, releaseUrl: URL, downloadId: string): string {
  const download = release.downloads.find((item) => item.id === downloadId);
  return download ? new URL(download.path, releaseUrl).href : releaseUrl.href;
}

function LoadingPage() {
  return (
    <main className="state-page" role="status">
      <span className="loading-mark" />
      <p>Loading release…</p>
    </main>
  );
}

function ErrorPage({ message }: { message: string }) {
  return (
    <main className="state-page" role="alert">
      <h1>Could not load the results</h1>
      <p>{message}</p>
    </main>
  );
}
