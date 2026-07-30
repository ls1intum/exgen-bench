import { useEffect, useState, type CSSProperties } from "react";
import {
  CartesianGrid,
  ErrorBar,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  type ScatterShapeProps,
  type TooltipContentProps,
  type YAxisTickContentProps,
} from "recharts";
import { approachVisual, type ApproachVisual } from "./presentation.tsx";
import { type Configuration, dollars, percent, seconds } from "./release.ts";

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
  model: string;
  approach: string;
  visual: ApproachVisual;
  providerId: string;
  providerName: string;
  providerMark: string | null;
  providerColor: string;
  showLabel: boolean;
  labelOffsetY: number;
  quality: number;
  qualityError: [number, number];
  intervalLow: number;
  intervalHigh: number;
  intervalMethod: string;
  accepted: number;
  planned: number;
  cost: number | null;
  costDenominator: number | null;
  latency: number | null;
  latencyDenominator: number | null;
}

function points(
  configurations: Configuration[],
  visuals: ReadonlyMap<string, ApproachVisual>,
): ChartPoint[] {
  return configurations.map(({ system, model, approach, provider }) => {
    const metrics = system.decision_metrics;
    return {
      id: system.id,
      label: model.length > 22 ? `${model.slice(0, 21)}…` : model,
      model,
      approach,
      visual: approachVisual(approach, visuals),
      providerId: provider.id,
      providerName: provider.name,
      providerMark: provider.mark,
      providerColor: provider.color,
      showLabel: false,
      labelOffsetY: 0,
      quality: system.primary.estimate,
      qualityError: [
        system.primary.estimate - system.primary.interval_low,
        system.primary.interval_high - system.primary.estimate,
      ],
      intervalLow: system.primary.interval_low,
      intervalHigh: system.primary.interval_high,
      intervalMethod: system.primary.interval_method,
      accepted: system.primary.numerator,
      planned: system.primary.denominator,
      cost: metrics?.cost?.estimate ?? null,
      costDenominator: metrics?.cost?.denominator ?? null,
      latency: metrics?.latency?.estimate ?? null,
      latencyDenominator: metrics?.latency?.denominator ?? null,
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
  const groupedByQuality = Map.groupBy(
    chartPoints.filter((point) => labeledIds.has(point.id)),
    (point) => point.quality.toFixed(3),
  );
  const offsets = new Map<string, number>();
  for (const group of groupedByQuality.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        (left.cost ?? Number.POSITIVE_INFINITY) - (right.cost ?? Number.POSITIVE_INFINITY),
    );
    ordered.forEach((point, index) => {
      offsets.set(
        point.id,
        ordered.length === 1 ? 0 : (index - (ordered.length - 1) / 2) * 20 - 10,
      );
    });
  }
  return chartPoints.map((point) => ({
    ...point,
    showLabel: labeledIds.has(point.id),
    labelOffsetY: offsets.get(point.id) ?? 0,
  }));
}

function ConfigurationTooltip({ active, payload }: TooltipContentProps) {
  const point = payload?.[0]?.payload as ChartPoint | undefined;
  if (!active || !point) return null;
  const Icon = point.visual.icon;
  return (
    <div className="chart-tooltip">
      <div className="flex items-center gap-2">
        <ProviderMark point={point} size={24} />
        <div>
          <strong>{point.model}</strong>
          <span className="flex items-center gap-1">
            <Icon aria-hidden="true" size={12} style={{ color: point.visual.color }} />
            {point.approach}
          </span>
        </div>
      </div>
      <dl>
        <div>
          <dt>Strict acceptance</dt>
          <dd>{percent(point.quality, 1)}</dd>
        </div>
        <div>
          <dt>Published interval</dt>
          <dd>
            {percent(point.intervalLow, 1)}–{percent(point.intervalHigh, 1)}
          </dd>
        </div>
        <div>
          <dt>Interval method</dt>
          <dd>{point.intervalMethod}</dd>
        </div>
        <div>
          <dt>Accepted</dt>
          <dd>
            {point.accepted}/{point.planned}
          </dd>
        </div>
        <div>
          <dt>Cost / attempt</dt>
          <dd>
            {point.cost === null
              ? "—"
              : `${dollars(point.cost)} · n = ${point.costDenominator} planned`}
          </dd>
        </div>
        <div>
          <dt>Median latency</dt>
          <dd>
            {point.latency === null
              ? "—"
              : `${seconds(point.latency)} · n = ${point.latencyDenominator} started`}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function ProviderMark({ point, size }: { point: ChartPoint; size: number }) {
  const style = { "--provider-color": point.providerColor } as CSSProperties;
  if (!point.providerMark) {
    return (
      <span className="provider-fallback" style={{ ...style, width: size, height: size }}>
        {point.providerName.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      className="provider-image"
      src={point.providerMark}
      alt=""
      width={size}
      height={size}
      style={style}
    />
  );
}

function ProviderGlyph({
  point,
  x,
  y,
  radius,
}: {
  point: ChartPoint;
  x: number;
  y: number;
  radius: number;
}) {
  return (
    <>
      <circle
        className="provider-glyph-surface"
        cx={x}
        cy={y}
        r={radius}
        strokeWidth={1}
        style={{ "--provider-color": point.providerColor } as CSSProperties}
      />
      {point.providerMark ? (
        <image
          href={point.providerMark}
          x={x - radius * 0.58}
          y={y - radius * 0.58}
          width={radius * 1.16}
          height={radius * 1.16}
        />
      ) : (
        <text x={x} y={y + 3.5} textAnchor="middle" className="point-initial">
          {point.providerName.slice(0, 1)}
        </text>
      )}
    </>
  );
}

function ApproachGlyph({
  point,
  x,
  y,
  size,
}: {
  point: ChartPoint;
  x: number;
  y: number;
  size: number;
}) {
  const Icon = point.visual.icon;
  return (
    <>
      <circle
        cx={x}
        cy={y}
        r={size / 2}
        fill={point.visual.color}
        stroke="var(--chart-mark)"
        strokeWidth={1.25}
      />
      <Icon
        aria-hidden="true"
        x={x - size * 0.28}
        y={y - size * 0.28}
        width={size * 0.56}
        height={size * 0.56}
        color="white"
        strokeWidth={2.5}
      />
    </>
  );
}

function ConfigurationMark({
  point,
  x,
  y,
  showLabel,
  compact = false,
}: {
  point: ChartPoint;
  x: number;
  y: number;
  showLabel: boolean;
  compact?: boolean;
}) {
  const radius = compact ? 10 : 12;
  const badgeSize = compact ? 9 : 11;
  const badgeOffset = compact ? 8 : 9;
  return (
    <g
      className="scatter-point"
      data-chart-mark="configuration"
      data-provider={point.providerId}
      data-approach={point.approach}
      data-symbol={point.visual.symbol}
    >
      <ProviderGlyph point={point} x={x} y={y} radius={radius} />
      <ApproachGlyph point={point} x={x + badgeOffset} y={y + badgeOffset} size={badgeSize} />
      {showLabel && (
        <text x={x + 22} y={y + 4 + point.labelOffsetY} className="point-label">
          {point.label}
        </text>
      )}
    </g>
  );
}

function ScatterPoint({ props, compact }: { props: ScatterShapeProps; compact: boolean }) {
  const point = props.payload as ChartPoint | undefined;
  if (!point || props.cx === undefined || props.cy === undefined) return null;
  return (
    <ConfigurationMark
      point={point}
      x={props.cx}
      y={props.cy}
      showLabel={point.showLabel}
      compact={compact}
    />
  );
}

function QualityPoint({ props, compact }: { props: ScatterShapeProps; compact: boolean }) {
  const point = props.payload as ChartPoint | undefined;
  if (!point || props.cx === undefined || props.cy === undefined) return null;
  return (
    <g>
      <ConfigurationMark
        point={point}
        x={props.cx}
        y={props.cy}
        showLabel={false}
        compact={compact}
      />
      <text x={props.cx + 22} y={props.cy + 4} className="bar-value">
        {percent(point.quality, 1)}
      </text>
    </g>
  );
}

function ConfigurationAxisTick({
  x,
  y,
  payload,
  pointsById,
  compact,
  denominator,
}: YAxisTickContentProps & {
  pointsById: ReadonlyMap<string, ChartPoint>;
  compact: boolean;
  denominator: (point: ChartPoint) => number;
}) {
  const point = pointsById.get(String(payload.value));
  if (!point) return null;
  const tickX = Number(x);
  const tickY = Number(y);
  const Icon = point.visual.icon;
  const model =
    point.model.length > (compact ? 18 : 30)
      ? `${point.model.slice(0, compact ? 17 : 29)}…`
      : point.model;
  return (
    <g
      data-chart-row={point.id}
      data-provider={point.providerId}
      data-approach={point.approach}
      data-symbol={point.visual.symbol}
    >
      <text
        x={tickX - 28}
        y={tickY - 3}
        textAnchor="end"
        fill="var(--chart-ink)"
        fontSize={compact ? 10 : 11}
      >
        {model}
      </text>
      <Icon
        aria-hidden="true"
        x={tickX - 23}
        y={tickY + 2}
        width={11}
        height={11}
        color={point.visual.color}
        strokeWidth={2.25}
      />
      <text x={tickX - 28} y={tickY + 12} textAnchor="end" fill="var(--chart-axis)" fontSize={9}>
        {point.approach} · n={denominator(point)}
      </text>
    </g>
  );
}

export function QualityChart({
  configurations,
  visuals,
}: {
  configurations: Configuration[];
  visuals: ReadonlyMap<string, ApproachVisual>;
}) {
  const compact = useCompactChart();
  const data = points(configurations, visuals).sort(
    (left, right) =>
      right.quality - left.quality ||
      left.model.localeCompare(right.model) ||
      left.approach.localeCompare(right.approach),
  );
  if (data.length === 0) {
    return <EmptyChart message="No configurations match these filters." />;
  }
  const pointsById = new Map(data.map((point) => [point.id, point]));
  const intervalMethods = [...new Set(data.map((point) => point.intervalMethod))];
  const description =
    intervalMethods.length === 1
      ? `Strict acceptance with ${intervalMethods[0]}. Higher is better.`
      : "Strict acceptance with each release-published uncertainty interval. Higher is better.";
  return (
    <figure aria-labelledby="quality-chart-title">
      <ChartHeading id="quality-chart-title" title="Strict acceptance" description={description} />
      <div
        className="chart-frame"
        data-testid="quality-chart"
        style={{ height: Math.max(430, data.length * (compact ? 40 : 44) + 62) }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            accessibilityLayer
            title="Strict acceptance"
            desc={description}
            data={data}
            margin={{ top: 14, right: compact ? 46 : 66, bottom: 18, left: 4 }}
          >
            <CartesianGrid
              vertical
              horizontal={false}
              stroke="var(--chart-grid)"
              strokeDasharray="3 5"
            />
            <XAxis
              type="number"
              dataKey="quality"
              domain={[0, 1]}
              tickFormatter={(value: number) => percent(value)}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="id"
              reversed
              allowDuplicatedCategory={false}
              interval={0}
              width={compact ? 126 : 202}
              axisLine={false}
              tickLine={false}
              tick={(props) => (
                <ConfigurationAxisTick
                  {...props}
                  pointsById={pointsById}
                  compact={compact}
                  denominator={(point) => point.planned}
                />
              )}
            />
            <Tooltip
              cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 4" }}
              content={ConfigurationTooltip}
            />
            <Scatter
              data={data}
              shape={(props) => <QualityPoint props={props} compact={compact} />}
              isAnimationActive={false}
            >
              <ErrorBar
                dataKey="qualityError"
                direction="x"
                stroke="var(--chart-interval)"
                strokeWidth={1.25}
                width={6}
              />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <ApproachLegend configurations={configurations} visuals={visuals} />
    </figure>
  );
}

type Metric = "cost" | "latency";

interface MetricPoint extends ChartPoint {
  value: number;
}

const METRICS: Record<
  Metric,
  {
    title: string;
    description: string;
    formatter: (value: number) => string;
    testId: string;
  }
> = {
  cost: {
    title: "Cost per attempt",
    description:
      "Mean cost per planned generation on the release's frozen pricing basis. Lower is better.",
    formatter: dollars,
    testId: "cost-chart",
  },
  latency: {
    title: "Generation latency",
    description: "Median generation time among started attempts. Lower is better.",
    formatter: seconds,
    testId: "latency-chart",
  },
};

function MetricPointMark({
  props,
  formatter,
  compact,
}: {
  props: ScatterShapeProps;
  formatter: (value: number) => string;
  compact: boolean;
}) {
  const point = props.payload as MetricPoint | undefined;
  if (!point || props.cx === undefined || props.cy === undefined) return null;
  return (
    <g>
      <ConfigurationMark
        point={point}
        x={props.cx}
        y={props.cy}
        showLabel={false}
        compact={compact}
      />
      <text x={props.cx + 22} y={props.cy + 4} className="bar-value">
        {formatter(point.value)}
      </text>
    </g>
  );
}

export function MetricChart({
  configurations,
  visuals,
  metric,
}: {
  configurations: Configuration[];
  visuals: ReadonlyMap<string, ApproachVisual>;
  metric: Metric;
}) {
  const compact = useCompactChart();
  const specification = METRICS[metric];
  const data = points(configurations, visuals)
    .flatMap((point): MetricPoint[] => {
      const value = metric === "cost" ? point.cost : point.latency;
      return value === null ? [] : [{ ...point, value }];
    })
    .sort(
      (left, right) =>
        left.value - right.value ||
        left.model.localeCompare(right.model) ||
        left.approach.localeCompare(right.approach),
    );
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
  const values = data.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const useLogScale = metric === "cost" && minimum > 0 && maximum / minimum >= 4;
  const domain: [number, number] = useLogScale
    ? [minimum * 0.75, maximum * 1.25]
    : [0, maximum === 0 ? 1 : maximum * (compact ? 1.22 : 1.14)];
  const ticks = useLogScale ? logarithmicTicks(domain) : undefined;
  const pointsById = new Map(data.map((point) => [point.id, point]));
  const description = useLogScale
    ? `${specification.description} The cost axis uses a logarithmic scale.`
    : specification.description;
  const coverage =
    data.length === configurations.length
      ? ""
      : ` Shown for ${data.length} of ${configurations.length} configurations with a published ${
          metric === "cost" ? "cost" : "latency"
        } summary.`;
  const completeDescription = `${description}${coverage}`;
  const denominator = (point: ChartPoint) =>
    metric === "cost" ? (point.costDenominator ?? 0) : (point.latencyDenominator ?? 0);
  return (
    <figure aria-labelledby={`${metric}-chart-title`}>
      <ChartHeading
        id={`${metric}-chart-title`}
        title={specification.title}
        description={completeDescription}
      />
      <div
        className="chart-frame"
        data-testid={specification.testId}
        style={{ height: Math.max(430, data.length * (compact ? 40 : 44) + 62) }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            accessibilityLayer
            title={specification.title}
            desc={completeDescription}
            data={data}
            margin={{ top: 14, right: compact ? 50 : 72, bottom: 18, left: 4 }}
          >
            <CartesianGrid
              vertical
              horizontal={false}
              stroke="var(--chart-grid)"
              strokeDasharray="3 5"
            />
            <XAxis
              type="number"
              dataKey="value"
              domain={domain}
              scale={useLogScale ? "log" : "auto"}
              {...(ticks ? { ticks } : {})}
              tickFormatter={specification.formatter}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="id"
              reversed
              allowDuplicatedCategory={false}
              interval={0}
              width={compact ? 126 : 202}
              axisLine={false}
              tickLine={false}
              tick={(props) => (
                <ConfigurationAxisTick
                  {...props}
                  pointsById={pointsById}
                  compact={compact}
                  denominator={denominator}
                />
              )}
            />
            <Tooltip
              cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 4" }}
              content={ConfigurationTooltip}
            />
            <Scatter
              data={data}
              shape={(props) => (
                <MetricPointMark
                  props={props}
                  formatter={specification.formatter}
                  compact={compact}
                />
              )}
              isAnimationActive={false}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <ApproachLegend configurations={configurations} visuals={visuals} />
    </figure>
  );
}

export function ValueChart({
  configurations,
  visuals,
}: {
  configurations: Configuration[];
  visuals: ReadonlyMap<string, ApproachVisual>;
}) {
  const compact = useCompactChart();
  const data = labelScatterPoints(
    points(configurations, visuals).filter(
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
  const description = `Higher and further left is better. Marks show the provider and generation approach.${
    useLogScale ? " Cost uses a logarithmic scale." : ""
  }${
    data.length === configurations.length
      ? ""
      : ` Shown for ${data.length} of ${configurations.length} configurations with a published cost summary.`
  }`;
  return (
    <figure aria-labelledby="value-chart-title">
      <ChartHeading id="value-chart-title" title="Cost–quality" description={description} />
      <div className="chart-frame chart-frame-tall" data-testid="value-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            accessibilityLayer
            title="Cost–quality"
            desc={description}
            margin={{ top: 30, right: compact ? 24 : 148, bottom: 28, left: 8 }}
          >
            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 5" />
            <XAxis
              type="number"
              dataKey="cost"
              scale={useLogScale ? "log" : "auto"}
              domain={costDomain}
              {...(costTicks ? { ticks: costTicks } : {})}
              tickFormatter={dollars}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
              label={{
                value: "Mean cost per planned attempt (USD)",
                position: "insideBottom",
                offset: -17,
                fill: "var(--chart-axis)",
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
              tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
              label={{
                value: "Strict acceptance",
                angle: -90,
                position: "insideLeft",
                fill: "var(--chart-axis)",
                fontSize: 11,
              }}
            />
            <Tooltip
              cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 4" }}
              content={ConfigurationTooltip}
            />
            <Scatter
              data={data}
              shape={(props) => <ScatterPoint props={props} compact={compact} />}
              isAnimationActive={false}
            >
              <ErrorBar
                dataKey="qualityError"
                direction="y"
                stroke="var(--chart-interval)"
                strokeWidth={1.25}
                width={5}
              />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <ApproachLegend configurations={configurations} visuals={visuals} />
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
  visuals,
}: {
  configurations: Configuration[];
  visuals: ReadonlyMap<string, ApproachVisual>;
}) {
  const visibleApproaches = [...new Set(configurations.map((item) => item.approach))].sort();
  return (
    <div className="approach-legend">
      {visibleApproaches.map((approach) => {
        const visual = approachVisual(approach, visuals);
        const Icon = visual.icon;
        return (
          <span
            key={approach}
            data-approach={approach}
            data-symbol={visual.symbol}
            style={{ color: visual.color }}
          >
            <Icon aria-hidden="true" width={12} height={12} />
            <span style={{ color: "inherit" }}>{approach}</span>
          </span>
        );
      })}
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
