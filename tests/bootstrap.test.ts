import { describe, expect, test } from "bun:test";
import { mean, quantileType7, resampledClusterMean, seededRandom } from "../analysis/bootstrap.ts";

describe("confirmatory bootstrap primitives", () => {
  test("matches the R type-7 interpolation definition", () => {
    const sample = [0, 10, 20, 30];
    expect(quantileType7(sample, 0)).toBe(0);
    expect(quantileType7(sample, 0.25)).toBe(7.5);
    expect(quantileType7(sample, 0.5)).toBe(15);
    expect(quantileType7(sample, 1)).toBe(30);
  });

  test("is deterministic and rejects empty summaries", () => {
    const first = seededRandom(42);
    const second = seededRandom(42);
    expect(Array.from({ length: 20 }, first)).toEqual(Array.from({ length: 20 }, second));
    expect(() => mean([])).toThrow("empty sample");
    expect(() => quantileType7([], 0.5)).toThrow("empty sample");
  });

  test("resamples complete clusters", () => {
    const draws = [0, 0.75];
    let index = 0;
    expect(resampledClusterMean([[0, 0, 0], [10]], () => draws[index++] ?? 0)).toBe(2.5);
    expect(index).toBe(2);
  });
});
