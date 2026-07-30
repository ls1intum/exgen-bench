import {
  ArrowRight,
  CircleDot,
  Diamond,
  Hexagon,
  ListChecks,
  Pentagon,
  Square,
  Star,
  Triangle,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { APPROACH_COLORS, assignApproachSymbolIndices } from "../approach-colors.ts";
import type { Configuration } from "./release.ts";

export interface ApproachVisual {
  color: string;
  icon: LucideIcon;
  symbol: string;
}

const APPROACH_VISUALS: ApproachVisual[] = [
  { color: APPROACH_COLORS[0], icon: ArrowRight, symbol: "arrow-right" },
  { color: APPROACH_COLORS[1], icon: ListChecks, symbol: "list-checks" },
  { color: APPROACH_COLORS[2], icon: Diamond, symbol: "diamond" },
  { color: APPROACH_COLORS[3], icon: Triangle, symbol: "triangle" },
  { color: APPROACH_COLORS[4], icon: Square, symbol: "square" },
  { color: APPROACH_COLORS[5], icon: Hexagon, symbol: "hexagon" },
  { color: APPROACH_COLORS[6], icon: Star, symbol: "star" },
  { color: APPROACH_COLORS[7], icon: Pentagon, symbol: "pentagon" },
  { color: APPROACH_COLORS[8], icon: CircleDot, symbol: "circle-dot" },
];

const DEFAULT_APPROACH_VISUAL: ApproachVisual = {
  color: "#94a3b8",
  icon: CircleDot,
  symbol: "circle-dot",
};

function stableIndex(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % APPROACH_VISUALS.length;
}

export function buildApproachVisuals(
  configurations: Configuration[],
): ReadonlyMap<string, ApproachVisual> {
  const visuals = new Map<string, ApproachVisual>();
  const approaches = [...new Set(configurations.map((item) => item.approach))].sort();
  const colors = new Map(
    approaches.map((approach) => [
      approach,
      configurations.find((item) => item.approach === approach)?.system.color ??
        APPROACH_COLORS[stableIndex(approach)] ??
        DEFAULT_APPROACH_VISUAL.color,
    ]),
  );
  const symbolIndices = assignApproachSymbolIndices(colors, APPROACH_VISUALS.length);
  for (const approach of approaches) {
    const visual = APPROACH_VISUALS[symbolIndices.get(approach) ?? stableIndex(approach)];
    if (visual) {
      visuals.set(approach, {
        ...visual,
        color: colors.get(approach) ?? visual.color,
      });
    }
  }
  return visuals;
}

export function approachVisual(
  approach: string,
  visuals: ReadonlyMap<string, ApproachVisual>,
): ApproachVisual {
  return (
    visuals.get(approach) ?? APPROACH_VISUALS[stableIndex(approach)] ?? DEFAULT_APPROACH_VISUAL
  );
}

export function ApproachBadge({
  approach,
  visuals,
}: {
  approach: string;
  visuals: ReadonlyMap<string, ApproachVisual>;
}) {
  const visual = approachVisual(approach, visuals);
  const Icon = visual.icon;
  return (
    <span
      className="approach-badge"
      data-approach={approach}
      data-symbol={visual.symbol}
      style={{ "--approach-color": visual.color } as CSSProperties}
    >
      <Icon aria-hidden="true" />
      {approach}
    </span>
  );
}

export function ProviderIcon({ provider }: { provider: Configuration["provider"] }) {
  return provider.mark ? (
    <span className="provider-icon" data-provider={provider.id}>
      <img src={provider.mark} alt="" />
    </span>
  ) : (
    <span
      className="provider-icon provider-fallback"
      data-provider={provider.id}
      aria-hidden="true"
    >
      {provider.name.slice(0, 1)}
    </span>
  );
}
