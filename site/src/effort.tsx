import { useId } from "react";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  type ScatterShapeProps,
  type TooltipContentProps,
} from "recharts";
import type { PublicAttempt, PublicRelease } from "../contracts.ts";
import { OUTCOMES, outcomeLabel, outcomeTone } from "./outcomes.ts";
import { compact, minutes } from "./release.ts";

interface EffortPoint {
  observation: string;
  title: string;
  outcome: PublicAttempt["outcome"];
  label: string;
  value: number;
}

type EffortMetric = "generation_duration_seconds" | "total_tokens";

const EFFORT: Record<
  EffortMetric,
  { title: string; description: string; format: (value: number) => string }
> = {
  generation_duration_seconds: {
    title: "Generation time per attempt",
    description: "Wall-clock time of every started attempt, by final disposition.",
    format: minutes,
  },
  total_tokens: {
    title: "Tokens per attempt",
    description: "Raw protocol tokens of every started attempt, by final disposition.",
    format: compact,
  },
};

function EffortTooltip({
  active,
  payload,
  metric,
}: TooltipContentProps & { metric: EffortMetric }) {
  const point = payload?.[0]?.payload as EffortPoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip strip-tooltip">
      <strong>{point.title}</strong>
      <span>
        {EFFORT[metric].format(point.value)} · {point.label}
      </span>
    </div>
  );
}

function EffortMark(props: ScatterShapeProps) {
  const point = props.payload as EffortPoint | undefined;
  if (!point || props.cx === undefined || props.cy === undefined) return null;
  return (
    <circle
      className={`effort-point outcome-${outcomeTone(point.outcome)}`}
      cx={props.cx}
      cy={props.cy}
      r={5}
    />
  );
}

export function EffortStrips({
  attempts,
  cases,
}: {
  attempts: PublicAttempt[];
  cases: PublicRelease["cases"];
}) {
  const metrics = (Object.keys(EFFORT) as EffortMetric[]).filter((metric) =>
    attempts.some((attempt) => attempt[metric] !== undefined),
  );
  if (metrics.length === 0) return null;
  return (
    <div className="effort-grid">
      {metrics.map((metric) => (
        <EffortStrip key={metric} metric={metric} attempts={attempts} cases={cases} />
      ))}
    </div>
  );
}

function EffortStrip({
  metric,
  attempts,
  cases,
}: {
  metric: EffortMetric;
  attempts: PublicAttempt[];
  cases: PublicRelease["cases"];
}) {
  const id = useId();
  const titles = new Map(cases.map((caseItem) => [caseItem.id, caseItem.title]));
  const outcomeOrder = new Map(OUTCOMES.map(([outcome], index) => [outcome, index]));
  const points: EffortPoint[] = attempts
    .flatMap((attempt) => {
      const value = attempt[metric];
      return value === undefined || attempt.lifecycle === "planned"
        ? []
        : [
            {
              observation: attempt.observation_id,
              title: titles.get(attempt.case_id) ?? attempt.case_id,
              outcome: attempt.outcome,
              label: outcomeLabel(attempt.outcome),
              value,
            },
          ];
    })
    .sort(
      (left, right) =>
        (outcomeOrder.get(left.outcome) ?? 0) - (outcomeOrder.get(right.outcome) ?? 0),
    );
  const rows = new Set(points.map((point) => point.outcome));
  const specification = EFFORT[metric];
  const description = `${specification.description} n = ${points.length}.`;
  return (
    <figure aria-labelledby={id}>
      <figcaption className="effort-heading">
        <h3 id={id}>{specification.title}</h3>
        <p>{description}</p>
      </figcaption>
      <div
        className="chart-frame effort-frame"
        data-testid={`effort-${metric}`}
        style={{ height: rows.size * 34 + 48 }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            accessibilityLayer
            aria-labelledby={id}
            desc={description}
            margin={{ top: 8, right: 18, bottom: 6, left: 4 }}
          >
            <CartesianGrid vertical horizontal={false} stroke="var(--chart-grid)" />
            <XAxis
              type="number"
              dataKey="value"
              domain={[0, "auto"]}
              tickFormatter={specification.format}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="label"
              allowDuplicatedCategory={false}
              interval={0}
              width={130}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--chart-ink)", fontSize: 11 }}
            />
            <Tooltip
              cursor={false}
              content={(props) => <EffortTooltip {...props} metric={metric} />}
            />
            <Scatter data={points} shape={EffortMark} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
