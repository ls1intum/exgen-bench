export interface CliffsDeltaResult {
  method: "cliffs_delta";
  size_a: number;
  size_b: number;
  greater: number;
  lesser: number;
  ties: number;
  delta: number;
  a12: number;
  magnitude: "negligible" | "small" | "medium" | "large";
}

/**
 * Cliff's delta and the equivalent Vargha-Delaney A12.
 *
 * delta = P(X > Y) - P(X < Y) over all pairs, and A12 = (delta + 1) / 2 = P(X > Y) + P(X = Y)/2.
 * Both are reported because the design's tables use A12 while the thresholds below are stated for
 * delta; deriving one from the other in code removes the chance of a mismatched pair in the paper.
 *
 * Magnitude thresholds are Romano et al. (2006): |delta| < 0.147 negligible, < 0.33 small,
 * < 0.474 medium, otherwise large. They are conventions, not inference, and the metric card says so.
 */
export function cliffsDelta(sampleA: number[], sampleB: number[]): CliffsDeltaResult {
  if (sampleA.length === 0 || sampleB.length === 0) {
    throw new Error("Cliff's delta requires two non-empty samples");
  }
  if ([...sampleA, ...sampleB].some((value) => !Number.isFinite(value))) {
    throw new Error("Cliff's delta requires finite observations");
  }
  const sortedB = [...sampleB].sort((left, right) => left - right);
  let greater = 0;
  let lesser = 0;
  let ties = 0;
  for (const value of sampleA) {
    const lowerBound = lowerBoundIndex(sortedB, value);
    const upperBound = upperBoundIndex(sortedB, value);
    greater += lowerBound;
    ties += upperBound - lowerBound;
    lesser += sortedB.length - upperBound;
  }
  const pairs = sampleA.length * sampleB.length;
  const delta = (greater - lesser) / pairs;
  const magnitude = Math.abs(delta);
  return {
    method: "cliffs_delta",
    size_a: sampleA.length,
    size_b: sampleB.length,
    greater,
    lesser,
    ties,
    delta,
    a12: (greater + ties / 2) / pairs,
    magnitude:
      magnitude < 0.147
        ? "negligible"
        : magnitude < 0.33
          ? "small"
          : magnitude < 0.474
            ? "medium"
            : "large",
  };
}

function lowerBoundIndex(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? Number.NaN) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function upperBoundIndex(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? Number.NaN) <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
