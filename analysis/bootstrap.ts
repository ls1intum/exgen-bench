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
