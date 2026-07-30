import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  LabelList,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  type BarProps,
  type ScatterShapeProps,
  type TooltipContentProps,
} from "recharts";
import { type Configuration, dollars, percent, seconds } from "./release.ts";

const APPROACH_COLORS = [
  "#5eead4",
  "#a78bfa",
  "#fbbf24",
  "#fb7185",
  "#7dd3fc",
  "#bef264",
  "#fdba74",
  "#f0abfc",
];

function approachColor(approach: string, approaches: string[]): string {
  return APPROACH_COLORS[approaches.indexOf(approach) % APPROACH_COLORS.length] ?? "#94a3b8";
}

function useCompactChart(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

function logarithmicTicks([minimum, maximum]: [number, number]): number[] {
  const ticks: number[] = [];
  const firstPower = Math.floor(Math.log10(minimum));
  const lastPower = Math.ceil(Math.log10(maximum));
  for (let power = firstPower; power <= lastPower; power += 1) {
    const magnitude = 10 ** power;
    for (const multiplier of [1, 2, 5]) {
      const tick = multiplier * magnitude;
      if (tick >= minimum && tick <= maximum) ticks.push(tick);
    }
  }
  if (ticks.length <= 5) return ticks;
  const lastIndex = ticks.length - 1;
  return [
    ...new Set([0, 0.25, 0.5, 0.75, 1].map((position) => ticks[Math.round(lastIndex * position)])),
  ].filter((tick): tick is number => tick !== undefined);
}

interface ChartPoint {
  id: string;
  label: string;
  category: string;
  model: string;
  approach: string;
  approachColor: string;
  providerName: string;
  providerMark: string | null;
  showLabel: boolean;
  labelOffsetY: number;
  quality: number;
  qualityError: [number, number];
  intervalLow: number;
  intervalHigh: number;
  accepted: number;
  planned: number;
  cost: number | null;
  latency: number | null;
}

function points(configurations: Configuration[], approaches: string[]): ChartPoint[] {
  return configurations.map(({ system, model, approach, provider }) => {
    const metrics = system.decision_metrics;
    return {
      id: system.id,
      label: model.length > 22 ? `${model.slice(0, 21)}…` : model,
      category: `${model.length > 20 ? `${model.slice(0, 19)}…` : model} · ${approach}`,
      model,
      approach,
      approachColor: approachColor(approach, approaches),
      providerName: provider.name,
      providerMark: provider.mark,
      showLabel: false,
      labelOffsetY: 0,
      quality: system.primary.estimate,
      qualityError: [
        system.primary.estimate - system.primary.interval_low,
        system.primary.interval_high - system.primary.estimate,
      ] as [number, number],
      intervalLow: system.primary.interval_low,
      intervalHigh: system.primary.interval_high,
      accepted: system.primary.numerator,
      planned: system.primary.denominator,
      cost: metrics?.cost?.estimate ?? null,
      latency: metrics?.latency?.estimate ?? null,
    };
  });
}

function labelScatterPoints(chartPoints: ChartPoint[]): ChartPoint[] {
  const labeledIds = new Set(
    [...new Set(chartPoints.map((point) => point.model))].flatMap((model) => {
      const best = chartPoints
        .filter((point) => point.model === model)
        .sort(
          (left, right) =>
            right.quality - left.quality ||
            (left.cost ?? Number.POSITIVE_INFINITY) - (right.cost ?? Number.POSITIVE_INFINITY),
        )[0];
      return best ? [best.id] : [];
    }),
  );
  const labeled = chartPoints.filter((point) => labeledIds.has(point.id));
  const groupedByQuality = Map.groupBy(labeled, (point) => point.quality.toFixed(3));
  const offsets = new Map<string, number>();
  for (const group of groupedByQuality.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        (left.cost ?? Number.POSITIVE_INFINITY) - (right.cost ?? Number.POSITIVE_INFINITY),
    );
    ordered.forEach((point, index) => {
      const offset = ordered.length === 1 ? 0 : (index - (ordered.length - 1) / 2) * 20 - 10;
      offsets.set(point.id, offset);
    });
  }
  return chartPoints.map((point) => ({
    ...point,
    showLabel: labeledIds.has(point.id),
    labelOffsetY: offsets.get(point.id) ?? 0,
  }));
}

function ValueTooltip({ active, payload }: TooltipContentProps) {
  const point = payload?.[0]?.payload as ChartPoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip">
      <div className="flex items-center gap-2">
        <ProviderMark point={point} size={24} />
        <div>
          <strong>{point.model}</strong>
          <span>{point.approach}</span>
        </div>
      </div>
      <dl>
        <div>
          <dt>Strict acceptance</dt>
          <dd>{percent(point.quality, 1)}</dd>
        </div>
        <div>
          <dt>95% interval</dt>
          <dd>
            {percent(point.intervalLow, 1)}–{percent(point.intervalHigh, 1)}
          </dd>
        </div>
        <div>
          <dt>Accepted</dt>
          <dd>
            {point.accepted}/{point.planned}
          </dd>
        </div>
        <div>
          <dt>Cost / attempt</dt>
          <dd>{point.cost === null ? "—" : dollars(point.cost)}</dd>
        </div>
        <div>
          <dt>Median latency</dt>
          <dd>{point.latency === null ? "—" : seconds(point.latency)}</dd>
        </div>
      </dl>
    </div>
  );
}

function ProviderMark({ point, size }: { point: ChartPoint; size: number }) {
  if (!point.providerMark) {
    return (
      <span className="provider-fallback" style={{ width: size, height: size }}>
        {point.providerName.slice(0, 1)}
      </span>
    );
  }
  return (
    <img className="provider-image" src={point.providerMark} alt="" width={size} height={size} />
  );
}

function ScatterPoint(props: ScatterShapeProps) {
  const point = props.payload as ChartPoint | undefined;
  if (!point || props.cx === undefined || props.cy === undefined) return null;
  const x = props.cx;
  const y = props.cy;
  return (
    <g className="scatter-point">
      <circle cx={x} cy={y} r={14} fill="#f8fafc" stroke={point.approachColor} strokeWidth={3} />
      {point.providerMark ? (
        <image href={point.providerMark} x={x - 8} y={y - 8} width={16} height={16} />
      ) : (
        <text x={x} y={y + 4} textAnchor="middle" className="point-initial">
          {point.providerName.slice(0, 1)}
        </text>
      )}
      {point.showLabel && (
        <text x={x + 20} y={y + 4 + point.labelOffsetY} className="point-label">
          {point.label}
        </text>
      )}
    </g>
  );
}

export function ValueChart({
  configurations,
  approaches,
}: {
  configurations: Configuration[];
  approaches: string[];
}) {
  const compact = useCompactChart();
  const data = labelScatterPoints(
    points(configurations, approaches).filter(
      (point): point is ChartPoint & { cost: number } => point.cost !== null,
    ),
  );
  if (data.length === 0) {
    return (
      <EmptyChart
        message={
          configurations.length === 0
            ? "No configurations match these filters."
            : "This release does not include precomputed cost summaries."
        }
      />
    );
  }
  const costs = data.flatMap((item) => (item.cost === null ? [] : [item.cost]));
  const minimumCost = Math.min(...costs);
  const maximumCost = Math.max(...costs);
  const padding = Math.max((maximumCost - minimumCost) * 0.12, 0.01);
  const useLogScale = minimumCost > 0 && maximumCost / minimumCost >= 4;
  const costDomain: [number, number] = useLogScale
    ? [minimumCost * 0.75, maximumCost * 1.25]
    : [Math.max(0, minimumCost - padding), maximumCost + padding];
  const costTicks = useLogScale ? logarithmicTicks(costDomain) : undefined;
  return (
    <figure aria-labelledby="value-chart-title">
      <ChartHeading
        id="value-chart-title"
        title="Cost–quality matrix"
        description="Higher and further left is better. Rings identify the generation approach."
      />
      <div className="chart-frame chart-frame-tall" data-testid="value-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            accessibilityLayer
            title="Cost–quality matrix"
            desc="Each point is a model-and-approach configuration. Higher strict acceptance and lower mean cost are better."
            margin={{ top: 30, right: compact ? 24 : 148, bottom: 28, left: 8 }}
          >
            <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" strokeDasharray="3 5" />
            <XAxis
              type="number"
              dataKey="cost"
              scale={useLogScale ? "log" : "auto"}
              domain={costDomain}
              {...(costTicks ? { ticks: costTicks } : {})}
              tickFormatter={dollars}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              label={{
                value: "Mean cost per planned attempt (USD)",
                position: "insideBottom",
                offset: -17,
                fill: "#94a3b8",
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              dataKey="quality"
              domain={[0, 1]}
              tickFormatter={(value: number) => percent(value)}
              axisLine={false}
              tickLine={false}
              width={44}
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              label={{
                value: "Strict acceptance",
                angle: -90,
                position: "insideLeft",
                fill: "#94a3b8",
                fontSize: 11,
              }}
            />
            <Tooltip
              cursor={{ stroke: "rgba(148, 163, 184, 0.32)", strokeDasharray: "3 4" }}
              content={ValueTooltip}
            />
            <Scatter data={data} shape={ScatterPoint} isAnimationActive="auto">
              <ErrorBar
                dataKey="qualityError"
                direction="y"
                stroke="#cbd5e1"
                strokeWidth={1.25}
                width={5}
              />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <ApproachLegend configurations={configurations} approaches={approaches} />
    </figure>
  );
}

type Metric = "quality" | "cost" | "latency";

const METRICS: Record<
  Metric,
  {
    title: string;
    description: string;
    domain: [number | "auto", number | "auto"];
    formatter: (value: number) => string;
  }
> = {
  quality: {
    title: "Strict acceptance",
    description: "Accepted programming exercises divided by all planned generations.",
    domain: [0, 1],
    formatter: (value) => percent(value, 1),
  },
  cost: {
    title: "Cost per planned generation",
    description: "Precomputed mean cost on the frozen pricing basis. Lower is better.",
    domain: [0, "auto"],
    formatter: dollars,
  },
  latency: {
    title: "Generation latency",
    description: "Precomputed median among started generations. Lower is better.",
    domain: [0, "auto"],
    formatter: seconds,
  },
};

function barValue(point: ChartPoint, metric: Metric): number {
  if (metric === "quality") return point.quality;
  if (metric === "cost") return point.cost ?? Number.NaN;
  return point.latency ?? Number.NaN;
}

function BarValueLabel({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  value = 0,
  formatter,
}: Pick<BarProps, "x" | "y" | "width" | "height"> & {
  value?: number;
  formatter: (value: number) => string;
}) {
  const xValue = Number(x);
  const yValue = Number(y);
  return (
    <text x={xValue + Number(width) + 8} y={yValue + Number(height) / 2 + 4} className="bar-value">
      {formatter(value)}
    </text>
  );
}

export function MetricChart({
  configurations,
  approaches,
  metric,
}: {
  configurations: Configuration[];
  approaches: string[];
  metric: Metric;
}) {
  const compact = useCompactChart();
  const specification = METRICS[metric];
  const direction = metric === "quality" ? -1 : 1;
  const data = points(configurations, approaches)
    .map((point) => ({ ...point, value: barValue(point, metric) }))
    .filter((point) => Number.isFinite(point.value))
    .sort((left, right) => direction * (left.value - right.value));

  if (data.length === 0) {
    return (
      <EmptyChart
        message={
          configurations.length === 0
            ? "No configurations match these filters."
            : `This release does not include precomputed ${metric} summaries.`
        }
      />
    );
  }

  return (
    <figure aria-labelledby={`${metric}-chart-title`}>
      <ChartHeading
        id={`${metric}-chart-title`}
        title={specification.title}
        description={specification.description}
      />
      <div
        className="chart-frame"
        data-testid={`${metric}-chart`}
        style={{ height: Math.max(430, data.length * 42 + 70) }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            accessibilityLayer
            title={specification.title}
            desc={specification.description}
            data={data}
            layout="vertical"
            margin={{ top: 8, right: compact ? 48 : 72, bottom: 16, left: compact ? 0 : 8 }}
          >
            <CartesianGrid
              horizontal={false}
              stroke="rgba(148, 163, 184, 0.12)"
              strokeDasharray="3 5"
            />
            <XAxis
              type="number"
              domain={specification.domain}
              tickFormatter={specification.formatter}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#94a3b8", fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey={compact ? "label" : "category"}
              width={compact ? 96 : 190}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#cbd5e1", fontSize: compact ? 9 : 11 }}
            />
            <Tooltip content={ValueTooltip} cursor={{ fill: "rgba(148, 163, 184, 0.06)" }} />
            <Bar dataKey="value" radius={[0, 5, 5, 0]} maxBarSize={22}>
              {data.map((point) => (
                <Cell key={point.id} fill={point.approachColor} />
              ))}
              <LabelList
                dataKey="value"
                content={(props) => (
                  <BarValueLabel
                    x={props.x}
                    y={props.y}
                    width={props.width}
                    height={props.height}
                    value={Number(props.value)}
                    formatter={specification.formatter}
                  />
                )}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ApproachLegend configurations={configurations} approaches={approaches} />
    </figure>
  );
}

function ChartHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <figcaption className="chart-heading">
      <div>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
    </figcaption>
  );
}

function ApproachLegend({
  configurations,
  approaches,
}: {
  configurations: Configuration[];
  approaches: string[];
}) {
  const visibleApproaches = approaches.filter((approach) =>
    configurations.some((item) => item.approach === approach),
  );
  return (
    <div className="approach-legend">
      {visibleApproaches.map((approach) => (
        <span key={approach}>
          <i style={{ backgroundColor: approachColor(approach, approaches) }} />
          {approach}
        </span>
      ))}
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="empty-chart" role="status">
      {message}
    </div>
  );
}
