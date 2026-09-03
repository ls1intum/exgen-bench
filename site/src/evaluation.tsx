import { type CSSProperties, useId, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, X } from "lucide-react";
import {
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type TooltipContentProps,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MetricCard } from "../../src/export/metric-card.ts";
import type {
  PublicAttempt,
  PublicMetricSummary,
  PublicRelease,
  PublicScore,
} from "../contracts.ts";
import { outcomeLabel } from "./outcomes.ts";
import { type PublicSystem, configuration, decimal, percent } from "./release.ts";

interface MetricView {
  card: MetricCard;
  summary: PublicMetricSummary;
  scores: PublicScore[];
}

interface MatrixRow {
  attempt: PublicAttempt;
  title: string;
  scores: Map<string, PublicScore>;
}

function cardKey(card: { id: string; version: string }): string {
  return `${card.id}\0${card.version}`;
}

function summaryCardKey(summary: PublicMetricSummary): string {
  return `${summary.metric_id}\0${summary.metric_version}`;
}

export function formatValue(card: MetricCard, value: PublicScore["value"]): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (card.value_type === "proportion") return percent(value, value === 1 || value === 0 ? 0 : 1);
  if (card.value_type === "count") return decimal(value, Number.isInteger(value) ? 0 : 1);
  return decimal(value);
}

function metricTotal(summary: PublicMetricSummary): number {
  return (
    summary.measured + summary.not_applicable + summary.quality_failure + summary.infra_failure
  );
}

function measuredValues(view: MetricView): number[] {
  return view.scores.flatMap((score) =>
    score.score_status === "ok" && typeof score.value === "number" ? [score.value] : [],
  );
}

function metricDomain(view: MetricView): [number, number] {
  if (view.card.value_type === "proportion") return [0, 1];
  const values = measuredValues(view);
  const maximum = Math.max(0, ...values);
  return [0, maximum === 0 ? 1 : maximum];
}

export function EvaluationSection({
  release,
  attempts,
  scores,
}: {
  release: PublicRelease;
  attempts: PublicAttempt[];
  scores: PublicScore[];
}) {
  const evaluations = release.evaluations;
  const [systemId, setSystemId] = useState(release.systems[0]?.id ?? "");
  if (!evaluations) return null;
  const system = release.systems.find((candidate) => candidate.id === systemId);
  if (!system) return null;
  const evaluators = [...evaluations.evaluators].sort(
    (left, right) => Number(right.authoritative) - Number(left.authoritative),
  );
  const evaluated = new Set(scores.map((score) => score.observation_id)).size;
  const cards = new Map(release.metrics.map((card, index) => [cardKey(card), { card, index }]));
  const metricCount = new Set(evaluations.metrics.map(summaryCardKey)).size;
  return (
    <section className="evaluation" aria-labelledby="evaluation-title">
      <div className="section-heading">
        <div>
          <h2 id="evaluation-title">What the evaluators measured</h2>
          <p>
            {metricCount} metrics from {evaluators.length} evaluators over {evaluated} evaluated
            attempts. A metric that did not apply is shown as not measured, never as zero.
          </p>
        </div>
      </div>
      {release.systems.length > 1 && (
        <Tabs value={systemId} onValueChange={(next) => setSystemId(String(next))}>
          <div className="tab-scroll">
            <TabsList aria-label="Generation system">
              {release.systems.map((candidate) => (
                <TabsTrigger key={candidate.id} value={candidate.id}>
                  {configuration(candidate).model} · {configuration(candidate).approach}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      )}
      <Tabs defaultValue={evaluators[0]?.id}>
        <div className="tab-scroll">
          <TabsList variant="line" aria-label="Evaluator">
            {evaluators.map((evaluator) => (
              <TabsTrigger key={evaluator.id} value={evaluator.id}>
                {evaluator.id}
                {evaluator.authoritative && (
                  <Badge variant="secondary" className="evaluator-badge">
                    authoritative
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {evaluators.map((evaluator) => {
          const views = evaluations.metrics
            .filter(
              (summary) => summary.evaluator_id === evaluator.id && summary.system_id === system.id,
            )
            .flatMap((summary): MetricView[] => {
              const card = cards.get(summaryCardKey(summary));
              if (!card) return [];
              return [
                {
                  card: card.card,
                  summary,
                  scores: scores.filter(
                    (score) =>
                      score.evaluator_id === evaluator.id &&
                      score.system_id === system.id &&
                      score.metric_id === summary.metric_id &&
                      score.metric_version === summary.metric_version,
                  ),
                },
              ];
            })
            .sort(
              (left, right) =>
                (cards.get(cardKey(left.card))?.index ?? 0) -
                (cards.get(cardKey(right.card))?.index ?? 0),
            );
          const evaluatedHere = new Set(
            views.flatMap((view) => view.scores.map((score) => score.observation_id)),
          ).size;
          return (
            <TabsContent key={evaluator.id} value={evaluator.id} className="evaluator-panel">
              <p className="evaluator-identity">
                {evaluator.id}@{evaluator.version} · {evaluator.revision} · {evaluatedHere} of{" "}
                {system.planned} attempts evaluated
              </p>
              <MetricTable evaluator={evaluator.id} planned={system.planned} views={views} />
              <ScoreMatrix
                evaluator={evaluator.id}
                system={system}
                cases={release.cases}
                attempts={attempts}
                views={views.filter((view) => view.summary.measured > 0)}
              />
            </TabsContent>
          );
        })}
      </Tabs>
    </section>
  );
}

function MetricTable({
  evaluator,
  planned,
  views,
}: {
  evaluator: string;
  planned: number;
  views: MetricView[];
}) {
  return (
    <Table className="metric-table" containerLabel={`Metrics reported by ${evaluator}`}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Metric</TableHead>
          <TableHead scope="col">Measured of planned</TableHead>
          <TableHead scope="col">Result</TableHead>
          <TableHead scope="col">Every value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {views.map((view) => (
          <MetricRow key={cardKey(view.card)} view={view} planned={planned} />
        ))}
      </TableBody>
    </Table>
  );
}

function MetricRow({ view, planned }: { view: MetricView; planned: number }) {
  const { card, summary } = view;
  const unmeasured = summary.measured === 0;
  const absent = [
    [summary.not_applicable, "not applicable"],
    [summary.quality_failure, "quality failure"],
    [summary.infra_failure, "infrastructure failure"],
    [planned - metricTotal(summary), "not evaluated"],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(" · ");
  return (
    <TableRow data-metric={card.id} data-measured={summary.measured}>
      <th scope="row" className="table-row-header metric-name">
        <strong>{card.name}</strong>
        <small>
          {card.id} · {card.tier} · {card.direction}
        </small>
      </th>
      <TableCell>
        <span className="coverage-cell">
          <span className="coverage-meter" aria-hidden="true">
            <span style={{ width: `${(summary.measured / Math.max(planned, 1)) * 100}%` }} />
          </span>
          {summary.measured} of {planned}
        </span>
        {absent && <small>{absent}</small>}
      </TableCell>
      <TableCell className={unmeasured ? "metric-unmeasured" : undefined}>
        <MetricResult view={view} />
      </TableCell>
      <TableCell className="strip-cell">
        <MetricStrip view={view} />
      </TableCell>
    </TableRow>
  );
}

function MetricResult({ view }: { view: MetricView }) {
  const { card, summary } = view;
  if (summary.measured === 0) return <>Not measured</>;
  if (card.value_type === "boolean") {
    const positives = view.scores.filter((score) => score.value === true).length;
    return (
      <>
        <strong>
          {positives} of {summary.measured}
        </strong>{" "}
        true
        <small>{percent(positives / summary.measured, 0)}</small>
      </>
    );
  }
  if (card.value_type === "string" || summary.distribution === null) {
    const values = [
      ...new Set(
        view.scores.flatMap((score) => (score.value === null ? [] : [String(score.value)])),
      ),
    ];
    return <>{values.join(", ")}</>;
  }
  const { distribution } = summary;
  return (
    <>
      <strong>{formatValue(card, distribution.median)}</strong> median
      <small>
        mean {formatValue(card, distribution.mean)} · {formatValue(card, distribution.minimum)}–
        {formatValue(card, distribution.maximum)}
      </small>
    </>
  );
}

interface StripPoint {
  observation: string;
  value: number;
  jitter: number;
}

function StripTooltip({ active, payload, card }: TooltipContentProps & { card: MetricCard }) {
  const point = payload?.[0]?.payload as StripPoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip strip-tooltip">
      <strong>{formatValue(card, point.value)}</strong>
      <span>{point.observation}</span>
    </div>
  );
}

function MetricStrip({ view }: { view: MetricView }) {
  const { card, summary } = view;
  if (summary.measured === 0) return null;
  if (card.value_type === "boolean") {
    const positives = view.scores.filter((score) => score.value === true).length;
    return (
      <span
        className="boolean-bar"
        role="img"
        aria-label={`${positives} true, ${summary.measured - positives} false`}
      >
        <span className="boolean-true" style={{ flexGrow: positives }} />
        <span className="boolean-false" style={{ flexGrow: summary.measured - positives }} />
      </span>
    );
  }
  if (card.value_type === "string") return null;
  const points: StripPoint[] = view.scores.flatMap((score, index) =>
    score.score_status === "ok" && typeof score.value === "number"
      ? [{ observation: score.observation_id, value: score.value, jitter: ((index * 7) % 5) - 2 }]
      : [],
  );
  const domain = metricDomain(view);
  return (
    <span
      role="img"
      aria-label={`${points.length} values between ${formatValue(card, domain[0])} and ${formatValue(card, domain[1])}`}
    >
      <ScatterChart width={220} height={34} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
        <XAxis type="number" dataKey="value" domain={domain} hide />
        <YAxis type="number" dataKey="jitter" domain={[-3, 3]} hide />
        <ZAxis range={[44, 44]} />
        <Tooltip cursor={false} content={(props) => <StripTooltip {...props} card={card} />} />
        <Scatter
          data={points}
          isAnimationActive={false}
          fill="var(--primary)"
          fillOpacity={0.5}
          stroke="var(--chart-mark)"
          strokeWidth={1}
        />
      </ScatterChart>
    </span>
  );
}

type SortState = { key: string; descending: boolean } | null;

function ScoreMatrix({
  evaluator,
  system,
  cases,
  attempts,
  views,
}: {
  evaluator: string;
  system: PublicSystem;
  cases: PublicRelease["cases"];
  attempts: PublicAttempt[];
  views: MetricView[];
}) {
  const [sort, setSort] = useState<SortState>(null);
  const captionId = useId();
  if (views.length === 0) return null;
  const titles = new Map(cases.map((caseItem) => [caseItem.id, caseItem.title]));
  const scoresByAttempt = new Map<string, Map<string, PublicScore>>();
  for (const view of views) {
    for (const score of view.scores) {
      const known = scoresByAttempt.get(score.observation_id) ?? new Map<string, PublicScore>();
      known.set(cardKey(view.card), score);
      scoresByAttempt.set(score.observation_id, known);
    }
  }
  const matrixRows: MatrixRow[] = attempts
    .filter((attempt) => attempt.system_id === system.id)
    .map((attempt) => ({
      attempt,
      title: titles.get(attempt.case_id) ?? attempt.case_id,
      scores: scoresByAttempt.get(attempt.observation_id) ?? new Map(),
    }));
  const replicates = new Set(matrixRows.map((row) => row.attempt.replicate)).size > 1;
  const caseOrder = new Map(cases.map((caseItem, index) => [caseItem.id, index]));
  const rows = matrixRows.sort((left, right) => {
    if (sort) {
      const leftValue = sortValue(left.scores.get(sort.key));
      const rightValue = sortValue(right.scores.get(sort.key));
      if ((leftValue === null) !== (rightValue === null)) return leftValue === null ? 1 : -1;
      if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
        return sort.descending ? rightValue - leftValue : leftValue - rightValue;
      }
    }
    return (
      (caseOrder.get(left.attempt.case_id) ?? 0) - (caseOrder.get(right.attempt.case_id) ?? 0) ||
      left.attempt.replicate - right.attempt.replicate
    );
  });
  const ranges = new Map(
    views.map((view) => {
      const values = measuredValues(view);
      return [cardKey(view.card), [Math.min(...values), Math.max(...values)] as [number, number]];
    }),
  );
  return (
    <figure className="score-matrix" aria-labelledby={captionId}>
      <figcaption id={captionId}>
        Every {evaluator} value for each of the {system.planned} planned attempts. Darker cells are
        larger values within a column; read each metric's direction before judging it. n/a: the
        metric did not apply to that candidate. —: the evaluator reported no value.
      </figcaption>
      <Table containerLabel={`${evaluator} values by attempt`}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Attempt</TableHead>
            {views.map((view) => {
              const key = cardKey(view.card);
              const active = sort?.key === key;
              return (
                <TableHead
                  key={key}
                  scope="col"
                  aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}
                >
                  <button
                    type="button"
                    className="sort-button"
                    onClick={() =>
                      setSort(
                        active && sort.descending
                          ? { key, descending: false }
                          : active
                            ? null
                            : { key, descending: true },
                      )
                    }
                  >
                    {view.card.name}
                    {active ? (
                      sort.descending ? (
                        <ArrowDown aria-hidden="true" />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown aria-hidden="true" />
                    )}
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.attempt.observation_id}
              data-evaluated={row.scores.size > 0}
              className={row.scores.size === 0 ? "matrix-unevaluated" : undefined}
            >
              <th scope="row" className="table-row-header">
                <strong>{row.title}</strong>
                <small>
                  {outcomeLabel(row.attempt.outcome)}
                  {replicates && ` · replicate ${row.attempt.replicate}`}
                </small>
              </th>
              {row.scores.size === 0 ? (
                <TableCell className="score-cell score-absent" colSpan={views.length}>
                  not evaluated
                </TableCell>
              ) : (
                views.map((view) => (
                  <ScoreCell
                    key={cardKey(view.card)}
                    card={view.card}
                    score={row.scores.get(cardKey(view.card))}
                    range={ranges.get(cardKey(view.card)) ?? [0, 1]}
                  />
                ))
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </figure>
  );
}

function sortValue(score: PublicScore | undefined): number | null {
  if (score?.score_status !== "ok") return null;
  if (typeof score.value === "number") return score.value;
  if (typeof score.value === "boolean") return score.value ? 1 : 0;
  return null;
}

const ABSENT_LABELS: Record<Exclude<PublicScore["score_status"], "ok">, string> = {
  not_applicable: "n/a",
  quality_failure: "quality failure",
  infra_failure: "infrastructure failure",
};

function ScoreCell({
  card,
  score,
  range,
}: {
  card: MetricCard;
  score: PublicScore | undefined;
  range: [number, number];
}) {
  if (score?.score_status !== "ok") {
    return (
      <TableCell className="score-cell score-absent">
        {score === undefined ? "—" : ABSENT_LABELS[score.score_status]}
      </TableCell>
    );
  }
  if (typeof score.value === "boolean") {
    return (
      <TableCell className="score-cell" data-value={String(score.value)}>
        {score.value ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
        {formatValue(card, score.value)}
      </TableCell>
    );
  }
  if (typeof score.value !== "number") {
    return <TableCell className="score-cell">{formatValue(card, score.value)}</TableCell>;
  }
  const span = range[1] - range[0];
  const magnitude = span === 0 ? 0 : (score.value - range[0]) / span;
  return (
    <TableCell
      className="score-cell score-heat"
      style={{ "--heat": `${Math.round(6 + magnitude * 42)}%` } as CSSProperties}
    >
      {formatValue(card, score.value)}
    </TableCell>
  );
}
