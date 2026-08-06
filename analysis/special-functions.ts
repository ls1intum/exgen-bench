/**
 * Special functions the inferential tests in this directory are built from.
 *
 * Everything here is double precision and self-contained: the benchmark must be able to reproduce a
 * published p-value without a scientific-computing dependency, and a reviewer must be able to read
 * the estimator rather than trust a binary. Each routine is unit-tested against R or SciPy values in
 * `tests/analysis-statistics.test.ts`.
 */

const LANCZOS_G = 607 / 128;
// Written at the precision a double actually carries, so that what is read is what is evaluated.
const LANCZOS_COEFFICIENTS = [
  0.999_999_999_999_997_1, 57.156_235_665_862_92, -59.597_960_355_475_49, 14.136_097_974_741_746,
  -0.491_913_816_097_620_2, 0.000_033_994_649_984_811_89, 0.000_046_523_628_927_048_58,
  -0.000_098_374_475_304_879_56, 0.000_158_088_703_224_912_5, -0.000_210_264_441_724_104_88,
  0.000_217_439_618_115_212_65, -0.000_164_318_106_536_763_9, 0.000_084_418_223_983_852_74,
  -0.000_026_190_838_401_581_408, 0.000_003_689_918_265_953_162,
];

/** Natural logarithm of the gamma function via the Lanczos approximation (g = 607/128, n = 15). */
export function logGamma(value: number): number {
  if (!(value > 0)) {
    throw new Error("logGamma requires a positive argument");
  }
  const shifted = value - 1;
  let series = LANCZOS_COEFFICIENTS[0] ?? 0;
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index += 1) {
    series += (LANCZOS_COEFFICIENTS[index] ?? 0) / (shifted + index);
  }
  const t = shifted + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Natural logarithm of n! for a non-negative integer. */
export function logFactorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("logFactorial requires a non-negative integer");
  }
  return logGamma(n + 1);
}

/** Natural logarithm of the binomial coefficient "n choose k". */
export function logBinomialCoefficient(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n) {
    throw new Error("logBinomialCoefficient requires integers with 0 <= k <= n");
  }
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

const EPSILON = 1e-15;
const MAXIMUM_ITERATIONS = 10_000;
const TINY = 1e-300;

/** Regularized lower incomplete gamma P(a, x), by series below the crossover and continued fraction above. */
export function regularizedGammaP(a: number, x: number): number {
  if (!(a > 0) || x < 0) {
    throw new Error("regularizedGammaP requires a > 0 and x >= 0");
  }
  if (x === 0) {
    return 0;
  }
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n <= MAXIMUM_ITERATIONS; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPSILON) {
        break;
      }
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  return 1 - regularizedGammaQ(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
export function regularizedGammaQ(a: number, x: number): number {
  if (!(a > 0) || x < 0) {
    throw new Error("regularizedGammaQ requires a > 0 and x >= 0");
  }
  if (x === 0) {
    return 1;
  }
  if (x < a + 1) {
    return 1 - regularizedGammaP(a, x);
  }
  // Lentz's modified continued fraction.
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAXIMUM_ITERATIONS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = b + an / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) {
      break;
    }
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized incomplete beta I_x(a, b) via the standard continued fraction with symmetry reflection. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0)) {
    throw new Error("regularizedIncompleteBeta requires positive shape parameters");
  }
  if (x < 0 || x > 1) {
    throw new Error("regularizedIncompleteBeta requires 0 <= x <= 1");
  }
  if (x === 0 || x === 1) {
    return x;
  }
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) {
    d = TINY;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIMUM_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) {
      break;
    }
  }
  return h;
}

/** Standard normal cumulative distribution function. */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) {
    return x > 0 ? 1 : 0;
  }
  const scaled = (x * x) / 2;
  if (x >= 0) {
    return 0.5 * (1 + regularizedGammaP(0.5, scaled));
  }
  return 0.5 * regularizedGammaQ(0.5, scaled);
}

/**
 * Standard normal quantile via Wichura's AS 241 algorithm; accurate to about 1e-16 across the range
 * this repository uses.
 */
export function normalQuantile(probability: number): number {
  if (!(probability > 0 && probability < 1)) {
    throw new Error("normalQuantile requires a probability strictly between zero and one");
  }
  const q = probability - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180_625 - q * q;
    return (
      (q *
        (((((((2_509.080_928_730_122_7 * r + 33_430.575_583_588_128) * r + 67_265.770_927_008_7) *
          r +
          45_921.953_931_549_87) *
          r +
          13_731.693_765_509_461) *
          r +
          1_971.590_950_306_551_3) *
          r +
          133.141_667_891_784_38) *
          r +
          3.387_132_872_796_366_5)) /
      (((((((5_226.495_278_852_546 * r + 28_729.085_735_721_943) * r + 39_307.895_800_092_71) * r +
        21_213.794_301_586_597) *
        r +
        5_394.196_021_424_751) *
        r +
        687.187_007_492_057_9) *
        r +
        42.313_330_701_600_911) *
        r +
        1)
    );
  }
  let r = q < 0 ? probability : 1 - probability;
  r = Math.sqrt(-Math.log(r));
  let value: number;
  if (r <= 5) {
    r -= 1.6;
    value =
      (((((((7.745_450_142_783_414e-4 * r + 0.022_723_844_989_269_184) * r +
        0.241_780_725_177_450_61) *
        r +
        1.270_458_252_452_368_4) *
        r +
        3.647_848_324_763_204_5) *
        r +
        5.769_497_221_460_691) *
        r +
        4.630_337_846_156_546) *
        r +
        1.423_437_110_749_683_5) /
      (((((((1.052_755_663_741_36e-9 * r + 5.475_938_084_995_345e-4) * r +
        0.015_198_666_563_616_457) *
        r +
        0.148_103_976_427_480_08) *
        r +
        0.689_767_334_985_1) *
        r +
        1.676_384_830_183_803_8) *
        r +
        2.053_191_626_637_759) *
        r +
        1);
  } else {
    r -= 5;
    value =
      (((((((2.010_334_399_292_288_1e-7 * r + 2.711_555_568_743_487_6e-5) * r +
        0.001_242_660_947_388_078_4) *
        r +
        0.026_532_189_526_576_124) *
        r +
        0.296_560_571_828_504_87) *
        r +
        1.784_826_539_917_291_3) *
        r +
        5.463_784_911_164_114) *
        r +
        6.657_904_643_501_103) /
      (((((((2.044_263_103_389_939_7e-15 * r + 1.421_511_758_316_446e-7) * r +
        1.846_318_317_510_054_8e-5) *
        r +
        7.868_691_311_456_133e-4) *
        r +
        0.014_875_361_290_850_615) *
        r +
        0.136_929_880_922_735_8) *
        r +
        0.599_832_206_555_888) *
        r +
        1);
  }
  return q < 0 ? -value : value;
}

/** Upper-tail probability of the chi-square distribution. */
export function chiSquareSurvival(statistic: number, degreesOfFreedom: number): number {
  if (!(degreesOfFreedom > 0)) {
    throw new Error("chi-square requires positive degrees of freedom");
  }
  if (statistic <= 0) {
    return 1;
  }
  return regularizedGammaQ(degreesOfFreedom / 2, statistic / 2);
}

/** Two-sided p-value of Student's t distribution. */
export function studentTTwoSided(statistic: number, degreesOfFreedom: number): number {
  if (!(degreesOfFreedom > 0)) {
    throw new Error("Student's t requires positive degrees of freedom");
  }
  const t = Math.abs(statistic);
  if (!Number.isFinite(t)) {
    return 0;
  }
  return regularizedIncompleteBeta(
    degreesOfFreedom / 2,
    0.5,
    degreesOfFreedom / (degreesOfFreedom + t * t),
  );
}

/** Upper-tail probability of Snedecor's F distribution. */
export function fSurvival(statistic: number, numerator: number, denominator: number): number {
  if (!(numerator > 0) || !(denominator > 0)) {
    throw new Error("F distribution requires positive degrees of freedom");
  }
  if (statistic <= 0) {
    return 1;
  }
  return regularizedIncompleteBeta(
    denominator / 2,
    numerator / 2,
    denominator / (denominator + numerator * statistic),
  );
}

const GAUSS_LEGENDRE_NODES = 96;
const gaussLegendre = buildGaussLegendre(GAUSS_LEGENDRE_NODES);

function buildGaussLegendre(nodes: number): { abscissa: number[]; weight: number[] } {
  const abscissa: number[] = [];
  const weight: number[] = [];
  for (let index = 1; index <= nodes; index += 1) {
    let x = Math.cos(Math.PI * ((index - 0.25) / (nodes + 0.5)));
    let derivative = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      let p0 = 1;
      let p1 = 0;
      for (let degree = 1; degree <= nodes; degree += 1) {
        const p2 = p1;
        p1 = p0;
        p0 = ((2 * degree - 1) * x * p1 - (degree - 1) * p2) / degree;
      }
      derivative = (nodes * (x * p0 - p1)) / (x * x - 1);
      const delta = p0 / derivative;
      x -= delta;
      if (Math.abs(delta) < 1e-15) {
        break;
      }
    }
    abscissa.push(x);
    weight.push(2 / ((1 - x * x) * derivative * derivative));
  }
  return { abscissa, weight };
}

function integrate(lower: number, upper: number, f: (x: number) => number): number {
  const half = (upper - lower) / 2;
  const middle = (upper + lower) / 2;
  let total = 0;
  for (let index = 0; index < GAUSS_LEGENDRE_NODES; index += 1) {
    const abscissa = gaussLegendre.abscissa[index] ?? 0;
    const weight = gaussLegendre.weight[index] ?? 0;
    total += weight * f(middle + half * abscissa);
  }
  return total * half;
}

const NORMAL_DENSITY_SCALE = 1 / Math.sqrt(2 * Math.PI);

/**
 * Upper-tail probability of the studentized range statistic with infinite degrees of freedom, which
 * is the reference distribution the Nemenyi post-hoc test uses after a Friedman test:
 *
 *   P(Q > q) = 1 - k ∫ φ(z) [Φ(z) - Φ(z - q)]^(k-1) dz
 *
 * Evaluated by 96-node Gauss-Legendre quadrature over the eight-sigma window that carries the mass.
 */
export function studentizedRangeSurvival(statistic: number, groups: number): number {
  if (!Number.isInteger(groups) || groups < 2) {
    throw new Error("the studentized range requires at least two groups");
  }
  if (statistic <= 0) {
    return 1;
  }
  const lower = -9;
  const upper = 9 + statistic;
  const segments = 24;
  const step = (upper - lower) / segments;
  let cumulative = 0;
  for (let segment = 0; segment < segments; segment += 1) {
    cumulative += integrate(lower + segment * step, lower + (segment + 1) * step, (z) => {
      const inner = normalCdf(z) - normalCdf(z - statistic);
      return inner <= 0 ? 0 : NORMAL_DENSITY_SCALE * Math.exp(-(z * z) / 2) * inner ** (groups - 1);
    });
  }
  return Math.min(1, Math.max(0, 1 - groups * cumulative));
}
