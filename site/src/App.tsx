import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, BookOpenCheck, ChevronDown, RotateCcw } from "lucide-react";
import { MetricChart, QualityChart, ValueChart } from "./charts.tsx";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApproachBadge,
  ProviderIcon,
  buildApproachVisuals,
  type ApproachVisual,
} from "./presentation.tsx";
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

type View = "quality" | "value" | "cost" | "speed";

function queryView(hasCost: boolean, hasLatency: boolean): View {
  const value = new URLSearchParams(window.location.search).get("view");
  if ((value === "value" || value === "cost") && hasCost) return value;
  if (value === "speed" && hasLatency) return value;
  return "quality";
}

export default function App() {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadRelease>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadRelease()
      .then((result) => {
        if (active) setLoaded(result);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Could not load this release.");
        }
      });
    return () => {
      active = false;
    };
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
  const visuals = useMemo(() => buildApproachVisuals(configurations), [configurations]);
  const hasCost = configurations.some((item) => item.system.decision_metrics?.cost !== undefined);
  const hasLatency = configurations.some(
    (item) => item.system.decision_metrics?.latency !== undefined,
  );
  const resultViewCount = 1 + (hasCost ? 2 : 0) + (hasLatency ? 1 : 0);
  const [view, setView] = useState<View>(() => queryView(hasCost, hasLatency));
  const [providers, setProviders] = useState(() => new Set(allProviders.map((item) => item.id)));
  const [approaches, setApproaches] = useState(() => new Set(allApproaches));

  const visible = configurations.filter(
    (item) => providers.has(item.provider.id) && approaches.has(item.approach),
  );
  const filtered = visible.length !== configurations.length;

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (view === "quality") parameters.delete("view");
    else parameters.set("view", view);
    const query = parameters.toString();
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, [view]);

  const resetFilters = () => {
    setProviders(new Set(allProviders.map((item) => item.id)));
    setApproaches(new Set(allApproaches));
  };

  return (
    <>
      <header className="topbar">
        <a className="brand" href="./" aria-label="exgen-bench home">
          <span className="brand-mark" aria-hidden="true">
            <BookOpenCheck />
          </span>
          <span className="brand-name">
            <strong>exgen</strong>
            <span>bench</span>
          </span>
          <span className="brand-context">Programming education benchmark</span>
        </a>
        <nav aria-label="Project links">
          <a href="#results">Results</a>
          <a href={downloadUrl(release, releaseUrl, "attempts_csv")}>Data</a>
          <a href="https://github.com/ls1intum/exgen-bench/blob/main/docs/METHODOLOGY.md">Method</a>
          <a href="https://github.com/ls1intum/exgen-bench">GitHub</a>
        </nav>
      </header>

      <main id="main-content">
        <section className="release-header" aria-labelledby="release-title">
          <div className="release-header-main">
            <div className="release-topline">
              <div className="release-metadata">
                <span>{release.release_id}</span>
                <span>{release.release_version}</span>
              </div>
              <div
                className="release-status"
                role={release.status === "illustrative" ? "note" : undefined}
              >
                <Badge variant="secondary" className="release-status-badge">
                  {release.status}
                </Badge>
                {release.status === "illustrative" && (
                  <p>Every model, cost, and result on this page is synthetic.</p>
                )}
              </div>
            </div>
            <h1 id="release-title">{release.title}</h1>
            <div className="release-bottomline">
              <p className="release-summary">{release.summary}</p>
              <dl className="release-scope" aria-label="Release scope">
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
              </dl>
            </div>
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

        <section id="results" className="results-shell" aria-label="Benchmark results">
          <Tabs
            className="gap-2"
            value={view}
            onValueChange={(next) => {
              if (next === "quality" || next === "value" || next === "cost" || next === "speed") {
                setView(next);
              }
            }}
          >
            <div className="controls">
              <div className="tab-scroll" data-view-count={resultViewCount}>
                <TabsList aria-label="Result view">
                  <TabsTrigger value="quality">Quality</TabsTrigger>
                  {hasCost && <TabsTrigger value="value">Cost–quality</TabsTrigger>}
                  {hasCost && <TabsTrigger value="cost">Cost</TabsTrigger>}
                  {hasLatency && <TabsTrigger value="speed">Speed</TabsTrigger>}
                </TabsList>
              </div>
              <div className="filter-row">
                <ApproachFilter
                  approaches={allApproaches}
                  selected={approaches}
                  onChange={setApproaches}
                  visuals={visuals}
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

            <TabsContent value="quality">
              <QualityChart configurations={visible} visuals={visuals} />
              <PrimaryContrast release={release} />
            </TabsContent>
            {hasCost && (
              <TabsContent value="value">
                <ValueChart configurations={visible} visuals={visuals} />
              </TabsContent>
            )}
            {hasCost && (
              <TabsContent value="cost">
                <MetricChart configurations={visible} visuals={visuals} metric="cost" />
              </TabsContent>
            )}
            {hasLatency && (
              <TabsContent value="speed">
                <MetricChart configurations={visible} visuals={visuals} metric="latency" />
              </TabsContent>
            )}
            <ConfigurationTable configurations={visible} visuals={visuals} view={view} />
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

function ApproachFilter({
  approaches,
  selected,
  onChange,
  visuals,
}: {
  approaches: string[];
  selected: Set<string>;
  onChange: (value: Set<string>) => void;
  visuals: ReadonlyMap<string, ApproachVisual>;
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
        Approach
        <Badge variant="secondary" className="filter-count">
          {selected.size}
        </Badge>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Approach</DropdownMenuLabel>
          {approaches.map((approach) => (
            <DropdownMenuCheckboxItem
              key={approach}
              checked={selected.has(approach)}
              onCheckedChange={() => toggle(approach)}
            >
              <ApproachBadge approach={approach} visuals={visuals} />
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
        Providers
        <Badge variant="secondary" className="filter-count">
          {selected.size}
        </Badge>
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

function PrimaryContrast({ release }: { release: PublicRelease }) {
  const contrast = release.primary_contrast;
  if (!contrast) return null;
  const systemA = release.systems.find((system) => system.id === contrast.system_a);
  const systemB = release.systems.find((system) => system.id === contrast.system_b);
  if (!systemA || !systemB) return null;

  return (
    <aside className="primary-contrast" aria-labelledby="primary-contrast-title">
      <div className="primary-contrast-heading">
        <h3 id="primary-contrast-title">Release-level primary contrast</h3>
        <p>
          {systemA.name} − {systemB.name}
        </p>
      </div>
      <dl>
        <div>
          <dt>Estimate</dt>
          <dd>{percentagePoints(contrast.estimate)}</dd>
        </div>
        <div>
          <dt>Interval</dt>
          <dd>
            {percentagePoints(contrast.interval_low)} to {percentagePoints(contrast.interval_high)}
          </dd>
        </div>
      </dl>
      <div className="primary-contrast-detail">
        <p>{contrast.unit}</p>
        <p>{contrast.method}</p>
        <p>{contrast.note}</p>
      </div>
    </aside>
  );
}

function ConfigurationTable({
  configurations,
  visuals,
  view,
}: {
  configurations: Configuration[];
  visuals: ReadonlyMap<string, ApproachVisual>;
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
      <Table className="configuration-table" containerLabel="Configuration comparison">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Model</TableHead>
            <TableHead scope="col">Approach</TableHead>
            <TableHead
              scope="col"
              aria-sort={view === "quality" || view === "value" ? "descending" : undefined}
            >
              Strict acceptance
            </TableHead>
            <TableHead scope="col" aria-sort={view === "cost" ? "ascending" : undefined}>
              Cost / attempt
            </TableHead>
            <TableHead scope="col" aria-sort={view === "speed" ? "ascending" : undefined}>
              Median latency
            </TableHead>
            <TableHead scope="col">Attempts</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((item) => (
            <ConfigurationRow key={item.system.id} configuration={item} visuals={visuals} />
          ))}
        </TableBody>
      </Table>
      <div className="mobile-configuration-list">
        {shown.map((item) => (
          <ConfigurationSummary key={item.system.id} configuration={item} visuals={visuals} />
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

function ConfigurationRow({
  configuration: item,
  visuals,
}: {
  configuration: Configuration;
  visuals: ReadonlyMap<string, ApproachVisual>;
}) {
  const { system } = item;
  const metrics = system.decision_metrics;
  return (
    <TableRow>
      <th scope="row" className="table-row-header">
        <span className="model-cell">
          <ProviderIcon provider={item.provider} />
          <span>
            <strong>{item.model}</strong>
            <small>{item.provider.name}</small>
          </span>
        </span>
      </th>
      <TableCell>
        <ApproachBadge approach={item.approach} visuals={visuals} />
      </TableCell>
      <TableCell>
        <strong>{percent(system.primary.estimate, 1)}</strong>
        <small>
          {percent(system.primary.interval_low)}–{percent(system.primary.interval_high)}
        </small>
      </TableCell>
      <TableCell>
        {metrics?.cost ? (
          <>
            {dollars(metrics.cost.estimate)}
            <small>n = {metrics.cost.denominator} planned</small>
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell>
        {metrics?.latency ? (
          <>
            {seconds(metrics.latency.estimate)}
            <small>n = {metrics.latency.denominator} started</small>
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell>{system.planned}</TableCell>
    </TableRow>
  );
}

function ConfigurationSummary({
  configuration: item,
  visuals,
}: {
  configuration: Configuration;
  visuals: ReadonlyMap<string, ApproachVisual>;
}) {
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
        <ApproachBadge approach={item.approach} visuals={visuals} />
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
          <dd>
            {metrics?.cost ? (
              <>
                {dollars(metrics.cost.estimate)}
                <small>n = {metrics.cost.denominator} planned</small>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>
            {metrics?.latency ? (
              <>
                {seconds(metrics.latency.estimate)}
                <small>n = {metrics.latency.denominator} started</small>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
    </article>
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
      <Accordion multiple className="release-accordion">
        <AccordionItem value="briefs">
          <AccordionTrigger>Results by brief</AccordionTrigger>
          <AccordionContent className="detail-content">
            <BriefTable cases={release.cases} systems={release.systems} />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="method">
          <AccordionTrigger>Method and limitations</AccordionTrigger>
          <AccordionContent className="detail-content prose-detail">
            <p>{release.notice}</p>
            <h3>Metrics</h3>
            <dl className="metric-definitions">
              {release.metrics.map((metric) => (
                <div key={metric.id}>
                  <dt>
                    {metric.name} <span>{metric.tier}</span>
                  </dt>
                  <dd>
                    {metric.construct} Denominator: {metric.denominator} · Unit: {metric.unit}
                  </dd>
                </div>
              ))}
            </dl>
            <h3>Limitations</h3>
            <ul>
              {release.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="provenance">
          <AccordionTrigger>Provenance and files</AccordionTrigger>
          <AccordionContent className="detail-content detail-grid">
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
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}

function BriefTable({ cases, systems }: { cases: PublicCase[]; systems: PublicSystem[] }) {
  return (
    <div className="brief-table">
      <Table containerLabel="Brief-level results">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Brief</TableHead>
            {systems.map((system) => (
              <TableHead key={system.id} scope="col">
                {configuration(system).model} · {configuration(system).approach}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((caseItem) => (
            <TableRow key={caseItem.id}>
              <th scope="row" className="table-row-header">
                <strong>{caseItem.title}</strong>
                <small>{caseItem.tags.join(" · ")}</small>
              </th>
              {systems.map((system) => {
                const result = caseItem.systems[system.id];
                return (
                  <TableCell key={system.id}>
                    {result ? `${result.accepted}/${result.denominator}` : "—"}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function downloadUrl(release: PublicRelease, releaseUrl: URL, downloadId: string): string {
  const download = release.downloads.find((item) => item.id === downloadId);
  return download ? new URL(download.path, releaseUrl).href : releaseUrl.href;
}

function percentagePoints(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "always",
  }).format(value * 100)} pp`;
}

function LoadingPage() {
  return (
    <main className="state-page">
      <Spinner className="size-5 text-primary" />
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
