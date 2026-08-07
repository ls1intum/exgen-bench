export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error("cannot compute the mean of an empty sample");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * R's default type-7 sample quantile: linear interpolation at (n - 1) * probability.
 */
export function quantileType7(sorted: number[], probability: number): number {
  if (sorted.length === 0) {
    throw new Error("cannot compute a quantile of an empty sample");
  }
  if (!(probability >= 0 && probability <= 1)) {
    throw new Error("quantile probability must be between zero and one");
  }
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("quantile index is out of bounds");
  }
  return lower + (upper - lower) * (position - lowerIndex);
}

export function resampledClusterMean(clusters: number[][], random: () => number): number {
  const sample = Array.from(
    { length: clusters.length },
    () => clusters[Math.floor(random() * clusters.length)],
  ).flatMap((cluster) => cluster ?? []);
  return mean(sample);
}

/**
 * Percentile interval over a resampling distribution, and whether that distribution can support
 * one. When every cluster carries the same outcome each resample is identical, so the distribution
 * is a point mass and the interval collapses to zero width — the percentile bootstrap is
 * inconsistent at a boundary of the parameter space (Efron & Tibshirani 1993, ch. 12-13). A
 * zero-width interval is not a confidence interval, so a degenerate draw must be reported under a
 * different method rather than published as one.
 */
export function percentileInterval(
  draws: number[],
  confidenceLevel: number,
): { interval: [number, number]; degenerate: boolean } {
  const sorted = [...draws].sort((left, right) => left - right);
  const alpha = 1 - confidenceLevel;
  const low = quantileType7(sorted, alpha / 2);
  const high = quantileType7(sorted, 1 - alpha / 2);
  return { interval: [low, high], degenerate: sorted[0] === sorted[sorted.length - 1] };
}
