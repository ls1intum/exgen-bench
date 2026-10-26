import { canonicalJson } from "../core/canonical.ts";
import type { MetricCard } from "./metric-card.ts";

/**
 * Combine the metric-card files of several evaluation tools into one set. The same card may appear
 * in more than one file and is kept once; two different cards under one (id, version) identity are
 * refused, because a release cannot say which definition its scores were produced under.
 */
export function mergeMetricCards(files: MetricCard[][]): MetricCard[] {
  const merged = new Map<string, MetricCard>();
  for (const cards of files) {
    for (const card of cards) {
      const identity = `${card.id}\0${card.version}`;
      const existing = merged.get(identity);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(card)) {
        throw new Error(
          `metric card ${card.id}@${card.version} is defined differently in two metric-card files`,
        );
      }
      merged.set(identity, card);
    }
  }
  return [...merged.values()];
}
