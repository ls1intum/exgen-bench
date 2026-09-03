import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  distinguishingFactorNames,
  type ResolvedTargetParameters,
  type System,
} from "../contracts.ts";
import { digestJson, sha256 } from "./canonical.ts";
import type { LoadedBenchmark } from "./load.ts";

export interface PlannedCase {
  id: string;
  title: string;
  tags: string[];
  brief: string;
  digest: string;
  targetParameters: ResolvedTargetParameters;
  origin: LoadedBenchmark["dataset"]["cases"][number]["origin"];
  authors: LoadedBenchmark["dataset"]["cases"][number]["authors"];
  license: string;
  exposure: LoadedBenchmark["dataset"]["cases"][number]["exposure"];
}

export interface AnalysisDesignReport {
  clusters: number;
  replicates: number;
  alpha: number;
  power: number;
  assumed_success_rate: number;
  assumed_arm_correlation: number;
  assumed_intra_case_correlation: number;
  design_effect: number;
  standard_error: number;
  minimum_detectable_effect: number;
  smallest_meaningful_effect: number;
  distinguishing_factors: string[];
  interval_method: "percentile_cluster_bootstrap";
  coverage_limitation: string;
  references: string[];
}

export const CLUSTER_INFERENCE_REFERENCES = [
  "Cameron, A. C., Gelbach, J. B., & Miller, D. L. (2008). Bootstrap-Based Improvements for Inference with Clustered Errors. Review of Economics and Statistics, 90(3), 414-427. https://doi.org/10.1162/rest.90.3.414",
  "Canay, I. A., Santos, A., & Shaikh, A. M. (2021). The Wild Bootstrap with a 'Small' Number of 'Large' Clusters. Review of Economics and Statistics, 103(2), 346-363. https://doi.org/10.1162/rest_a_00887",
  "MacKinnon, J. G., Nielsen, M. O., & Webb, M. D. (2023). Cluster-robust inference: A guide to empirical practice. Journal of Econometrics, 232(2), 272-299. https://doi.org/10.1016/j.jeconom.2022.04.001",
] as const;

export const CLUSTER_COVERAGE_LIMITATION =
  "The percentile case-clustered bootstrap offers no asymptotic refinement and is calibrated for a large number of clusters. Below roughly forty clusters it under-covers: reported intervals are narrower and rejection rates higher than nominal. No wild-cluster bootstrap or approximate-randomization refinement is applied, so the stated confidence level is an upper bound on actual coverage.";

const COVERAGE_LIMITATION = `${CLUSTER_COVERAGE_LIMITATION} The minimum detectable effect recorded here uses normal quantiles and a variance bound, so the effect this design can actually resolve is larger still.`;

/**
 * Acklam's rational approximation of the standard normal inverse CDF; |error| < 1.15e-9.
 */
function standardNormalQuantile(probability: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const evaluate = (coefficients: number[], value: number): number =>
    coefficients.reduce((accumulator, coefficient) => accumulator * value + coefficient, 0);
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      evaluate(c, q) / ((((d[0] ?? 0) * q + (d[1] ?? 0)) * q + (d[2] ?? 0)) * q + (d[3] ?? 0) + 1)
    );
  }
  if (probability > 1 - low) {
    return -standardNormalQuantile(1 - probability);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (evaluate(a, r) * q) / (evaluate(b, r) * r + 1);
}

function analysisDesign(
  loaded: LoadedBenchmark,
  clusters: number,
): AnalysisDesignReport | undefined {
  const design = loaded.config.analysis.design;
  if (design === undefined || !loaded.config.analysis.estimand.endsWith("_difference")) {
    return undefined;
  }
  const replicates = loaded.config.trials.replicates;
  const alpha = 1 - loaded.config.analysis.confidence_level;
  const variance =
    2 *
    design.assumed_success_rate *
    (1 - design.assumed_success_rate) *
    (1 - design.assumed_arm_correlation);
  const designEffect = 1 + (replicates - 1) * design.assumed_intra_case_correlation;
  const standardError = Math.sqrt((variance * designEffect) / (clusters * replicates));
  const minimumDetectableEffect =
    (standardNormalQuantile(1 - alpha / 2) + standardNormalQuantile(design.power)) * standardError;
  return {
    clusters,
    replicates,
    alpha,
    power: design.power,
    assumed_success_rate: design.assumed_success_rate,
    assumed_arm_correlation: design.assumed_arm_correlation,
    assumed_intra_case_correlation: design.assumed_intra_case_correlation,
    design_effect: designEffect,
    standard_error: standardError,
    minimum_detectable_effect: minimumDetectableEffect,
    smallest_meaningful_effect: design.smallest_meaningful_effect,
    distinguishing_factors: distinguishingFactorNames(loaded.config.systems),
    interval_method: "percentile_cluster_bootstrap",
    coverage_limitation: COVERAGE_LIMITATION,
    references: [...CLUSTER_INFERENCE_REFERENCES],
  };
}

function resolveTargetParameters(
  target: LoadedBenchmark["config"]["target"],
  caseId: string,
): ResolvedTargetParameters {
  const { case_overrides: overrides, ...base } = target.parameters;
  const override = overrides[caseId] ?? {};
  return { ...base, ...override, language: override.language ?? base.language };
}

export interface PlannedAttempt {
  ordinal: number;
  id: string;
  generationKey: string;
  caseId: string;
  systemId: string;
  replicate: number;
  seed: number;
}

export interface ExperimentPlan {
  schema_version: "1";
  id: string;
  benchmark: {
    id: string;
    title: string;
  };
  dataset: {
    id: string;
    version: string;
    digest: string;
    /**
     * Provenance the dataset declares about itself, carried verbatim so it reaches the run manifest
     * and everything derived from it. Already bound into `digest`, so it does not enter the plan
     * identity a second time.
     */
    extensions: LoadedBenchmark["dataset"]["extensions"];
  };
  target: LoadedBenchmark["config"]["target"];
  budget: LoadedBenchmark["config"]["budget"];
  systems: System[];
  trials: LoadedBenchmark["config"]["trials"];
  analysis: LoadedBenchmark["config"]["analysis"];
  analysis_design?: AnalysisDesignReport;
  schedule: {
    method: "randomized_complete_blocks";
    seed: string;
  };
  execution: LoadedBenchmark["config"]["execution"];
  reference_pricing?: LoadedBenchmark["config"]["reference_pricing"];
  extensions: LoadedBenchmark["config"]["extensions"];
  cases: PlannedCase[];
  attempts: PlannedAttempt[];
}

function pairedSeed(baseSeed: number, caseId: string, replicate: number): number {
  const digest = sha256(`${baseSeed}\0${caseId}\0${replicate}`);
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

function deterministicShuffle<T>(values: T[], seedHex: string): T[] {
  let state = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0;
  const random = (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };

  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];
    if (current === undefined || swap === undefined) {
      throw new Error("shuffle index is out of bounds");
    }
    shuffled[index] = swap;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

async function resolveBrief(datasetDirectory: string, brief: string): Promise<string> {
  if (isAbsolute(brief)) {
    throw new Error(`dataset brief paths must be relative: ${brief}`);
  }
  const path = resolve(datasetDirectory, brief);
  const relativePath = relative(datasetDirectory, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`dataset brief escapes its dataset directory: ${brief}`);
  }
  let current = datasetDirectory;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`dataset brief paths must not contain symbolic links: ${brief}`);
    }
  }
  return path;
}

export async function createPlan(loaded: LoadedBenchmark): Promise<ExperimentPlan> {
  const cases: PlannedCase[] = await Promise.all(
    loaded.dataset.cases.map(async (datasetCase) => {
      const briefPath = await resolveBrief(loaded.datasetDirectory, datasetCase.brief);
      const brief = await readFile(briefPath, "utf8");
      return {
        id: datasetCase.id,
        title: datasetCase.title,
        tags: datasetCase.tags,
        brief,
        targetParameters: resolveTargetParameters(loaded.config.target, datasetCase.id),
        origin: datasetCase.origin,
        authors: datasetCase.authors,
        license: datasetCase.license,
        exposure: datasetCase.exposure,
        digest: digestJson({
          id: datasetCase.id,
          title: datasetCase.title,
          tags: datasetCase.tags,
          brief,
          origin: datasetCase.origin,
          authors: datasetCase.authors,
          license: datasetCase.license,
          exposure: datasetCase.exposure,
          extensions: datasetCase.extensions,
        }),
      };
    }),
  );

  const unknownOverrides = Object.keys(loaded.config.target.parameters.case_overrides).filter(
    (caseId) => !cases.some((datasetCase) => datasetCase.id === caseId),
  );
  if (unknownOverrides.length > 0) {
    throw new Error(
      `target parameter overrides reference cases outside the dataset: ${unknownOverrides.sort().join(", ")}`,
    );
  }

  const design = analysisDesign(loaded, cases.length);
  if (design && design.minimum_detectable_effect > design.smallest_meaningful_effect) {
    throw new Error(
      `this design cannot detect its declared smallest meaningful effect: minimum detectable effect ${design.minimum_detectable_effect.toFixed(
        4,
      )} exceeds ${design.smallest_meaningful_effect} at ${design.clusters} cases × ${
        design.replicates
      } replicates`,
    );
  }

  const datasetDigest = digestJson({
    id: loaded.dataset.id,
    version: loaded.dataset.version,
    license: loaded.dataset.license,
    cases,
    extensions: loaded.dataset.extensions,
  });

  const systemsGenerationIdentity = loaded.config.systems.map((system) => ({
    id: system.id,
    version: system.version,
    revision: system.revision,
    runtime: system.runtime,
    factors: system.factors,
    parameters: system.parameters,
    attestation: system.attestation,
  }));
  const scheduleSeed = digestJson({
    dataset: datasetDigest,
    systems: systemsGenerationIdentity.map(({ id, version, revision }) => ({
      id,
      version,
      revision,
    })),
    trials: loaded.config.trials,
    analysis: loaded.config.analysis,
  });
  const schedule = {
    method: "randomized_complete_blocks" as const,
    seed: scheduleSeed,
  };
  const planIdentity = {
    benchmark: { id: loaded.config.id },
    dataset: {
      id: loaded.dataset.id,
      version: loaded.dataset.version,
      digest: datasetDigest,
    },
    target: loaded.config.target,
    budget: loaded.config.budget,
    systems: systemsGenerationIdentity,
    trials: loaded.config.trials,
    analysis: loaded.config.analysis,
    schedule,
    execution: {
      concurrency: loaded.config.execution.concurrency,
      max_log_bytes: loaded.config.execution.max_log_bytes,
    },
    reference_pricing: loaded.config.reference_pricing,
  };
  const planId = digestJson(planIdentity);

  const attemptBlocks = cases.flatMap((datasetCase) =>
    Array.from(
      { length: loaded.config.trials.replicates },
      (_, replicateIndex) => replicateIndex + 1,
    ).map((replicate) => {
      const seed = pairedSeed(loaded.config.trials.base_seed, datasetCase.id, replicate);
      return loaded.config.systems.map((system) => {
        const generationKey = digestJson({
          benchmark: loaded.config.id,
          dataset: { id: loaded.dataset.id, version: loaded.dataset.version },
          case: { id: datasetCase.id, digest: datasetCase.digest },
          system: systemsGenerationIdentity.find((candidate) => candidate.id === system.id),
          target: {
            id: loaded.config.target.id,
            version: loaded.config.target.version,
            revision: loaded.config.target.revision,
            parameters: datasetCase.targetParameters,
          },
          budget: loaded.config.budget,
          replicate,
          seed,
        });
        return {
          ordinal: 0,
          id: `${safeName(datasetCase.id)}--${safeName(system.id)}--r${replicate
            .toString()
            .padStart(3, "0")}--${generationKey.slice(0, 12)}`,
          generationKey,
          caseId: datasetCase.id,
          systemId: system.id,
          replicate,
          seed,
        };
      });
    }),
  );

  const scheduledAttempts = deterministicShuffle(attemptBlocks, scheduleSeed)
    .flatMap((block) =>
      deterministicShuffle(
        block,
        digestJson({
          scheduleSeed,
          caseId: block[0]?.caseId,
          replicate: block[0]?.replicate,
        }),
      ),
    )
    .map((attempt, index) => ({
      ...attempt,
      ordinal: index + 1,
    }));

  return {
    schema_version: "1",
    id: planId,
    benchmark: { id: loaded.config.id, title: loaded.config.title },
    dataset: { ...planIdentity.dataset, extensions: loaded.dataset.extensions },
    target: loaded.config.target,
    budget: loaded.config.budget,
    systems: loaded.config.systems,
    trials: loaded.config.trials,
    analysis: loaded.config.analysis,
    ...(design === undefined ? {} : { analysis_design: design }),
    schedule,
    execution: loaded.config.execution,
    ...(loaded.config.reference_pricing === undefined
      ? {}
      : { reference_pricing: loaded.config.reference_pricing }),
    extensions: loaded.config.extensions,
    cases,
    attempts: scheduledAttempts,
  };
}
