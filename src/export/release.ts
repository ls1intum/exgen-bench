import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type PairedBootstrapResult,
  pairedCaseBootstrap,
} from "../../analysis/paired-bootstrap.ts";
import {
  type SystemBootstrapResult,
  systemCaseBootstrap,
} from "../../analysis/system-bootstrap.ts";
import { canonicalJson, sha256 } from "../core/canonical.ts";
import { CLUSTER_COVERAGE_LIMITATION, CLUSTER_INFERENCE_REFERENCES } from "../core/plan.ts";
import type {
  EvaluationResponse,
  EvaluationSuite,
  EvaluatorIdentity,
} from "../evaluation/contracts.ts";
import type { BenchmarkConfig, System } from "../contracts.ts";
import { type GenerationObservation, summarizeEvaluation } from "../evaluation/summary.ts";
import { buildAnalysisRecords } from "./analysis.ts";
import {
  PUBLIC_DISCLOSURE_PROFILE,
  publicEvaluation,
  publicEvidenceIndex,
  publicRunProvenance,
} from "./disclosure.ts";
import { type MetricCard, metricCardsSchema } from "./metric-card.ts";
import { croissantMetadata, type ReleaseFile, roCrateMetadata } from "./research-metadata.ts";
import { toCsv, toJsonLines } from "./serialize.ts";
import { ATTEMPT_COLUMNS, SCORE_COLUMNS } from "./tabular-contract.ts";

export interface ReleaseDesignation {
  status: "submitted" | "exploratory";
}

export interface PreregisteredContrast {
  system_a: string;
  system_b: string;
}

export interface ReleaseExportOptions {
  outputDirectory: string;
  release: {
    id: string;
    version: string;
    title: string;
    description: string;
    license: string;
    url: string;
    creators: Array<{ name: string; orcid: string }>;
    createdAt: string;
    designation: ReleaseDesignation;
  };
  benchmark: {
    id: string;
    planDigest: string;
    datasetId: string;
    datasetVersion: string;
    datasetDigest: string;
    target: { id: string; version: string; revision: string };
  };
  systems: Array<Pick<System, "id" | "name" | "version" | "revision" | "factors" | "attestation">>;
  cases: Array<{
    id: string;
    title: string;
    tags: string[];
    brief: string;
    digest: string;
    origin?: {
      kind: "synthetic" | "adapted" | "collected";
      source_uri?: string | undefined;
      citation?: string | undefined;
      created_at: string;
      first_public_at?: string | undefined;
    };
    authors?: Array<{ name: string; orcid?: string | undefined }>;
    license?: string;
    exposure?: { generator_visible: true; known_public: boolean; notes: string };
  }>;
  metricCards: MetricCard[];
  runManifest: unknown;
  generations: GenerationObservation[];
  evaluations: EvaluationResponse[];
  evaluationHistory: EvaluationResponse[];
  analysis: {
    method: BenchmarkConfig["analysis"]["method"];
    estimand: BenchmarkConfig["analysis"]["estimand"];
    bootstrapSeed: number;
    bootstrapResamples: number;
    confidenceLevel?: number;
    contrasts?: PreregisteredContrast[];
    registration?: {
      uri: string;
      registered_at: string;
      revision: string;
      amendment_uri?: string | undefined;
    };
  };
}

export interface ReleaseExportResult {
  directory: string;
  manifestDigest: string;
  files: ReleaseFile[];
}

function mediaType(path: string): string {
  if (path.endsWith(".csv")) {
    return "text/csv";
  }
  if (path.endsWith(".jsonl")) {
    return "application/x-ndjson";
  }
  if (path.endsWith(".txt")) {
    return "text/plain";
  }
  return "application/json";
}

function validateDesignation(designation: ReleaseDesignation): void {
  if (designation.status !== "submitted" && designation.status !== "exploratory") {
    throw new Error("release designation must be submitted or exploratory");
  }
}

function validateReleaseIdentity(options: ReleaseExportOptions): void {
  if (
    !options.release.id ||
    !options.release.version ||
    Number.isNaN(Date.parse(options.release.createdAt))
  ) {
    throw new Error("release requires a stable ID, version, and ISO-8601 creation timestamp");
  }
  try {
    new URL(options.release.url);
  } catch {
    throw new Error("release URL must be an absolute URL");
  }
  if (options.release.creators.length === 0) {
    throw new Error("release requires at least one creator");
  }
  const orcids = options.release.creators.map((creator) => creator.orcid);
  if (
    orcids.some((orcid) => !/^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) ||
    new Set(orcids).size !== orcids.length
  ) {
    throw new Error("release creators require unique canonical ORCID URLs");
  }
}

function attestedSystems(systems: ReleaseExportOptions["systems"]): unknown[] {
  return systems.map((system) => {
    if (!Array.isArray(system.attestation?.deployment_deviations)) {
      throw new Error(
        `system ${system.id} has no deployment attestation; declare every deviation from the standard deployment, or an empty list`,
      );
    }
    const entries = Object.entries(system.factors);
    return {
      id: system.id,
      name: system.name,
      version: system.version,
      revision: system.revision,
      factors: Object.fromEntries(entries.map(([name, factor]) => [name, factor.value])),
      factor_controls: Object.fromEntries(entries.map(([name, factor]) => [name, factor.control])),
      attestation: system.attestation,
    };
  });
}

interface RecordedAnalysisDesign {
  minimum_detectable_effect: number;
  smallest_meaningful_effect: number;
  clusters: number;
  replicates: number;
  power: number;
  coverage_limitation: string;
  references: string[];
}

function recordedAnalysisDesign(runManifest: unknown): RecordedAnalysisDesign | null {
  const manifest = runManifest as { plan?: { analysis_design?: RecordedAnalysisDesign } };
  return manifest.plan?.analysis_design ?? null;
}

function validateEvaluationHistory(
  latest: EvaluationResponse[],
  history: EvaluationResponse[],
): void {
  const lastById = new Map<string, EvaluationResponse>();
  for (const response of history) {
    const previous = lastById.get(response.evaluation_id);
    if (previous !== undefined && previous.status !== "infra_failed") {
      throw new Error(
        `evaluation history continues after terminal outcome ${response.evaluation_id}`,
      );
    }
    lastById.set(response.evaluation_id, response);
  }
  if (lastById.size !== latest.length) {
    throw new Error("evaluation history does not reconcile with latest evaluation outcomes");
  }
  for (const response of latest) {
    const recorded = lastById.get(response.evaluation_id);
    if (recorded === undefined || canonicalJson(recorded) !== canonicalJson(response)) {
      throw new Error(`evaluation history latest record does not match ${response.evaluation_id}`);
    }
  }
}

function validateFormalRelease(options: ReleaseExportOptions): void {
  if (options.release.designation.status === "exploratory") {
    return;
  }
  throw new Error(
    "submitted releases are not enabled: the benchmark still needs a frozen registration snapshot, resolved treatment attestations, a content-addressed raw archive, and a validated evaluator-suite manifest",
  );
}

async function outputMustNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`release output already exists: ${path}`);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
}

async function describeFiles(root: string, paths: string[]): Promise<ReleaseFile[]> {
  return Promise.all(
    [...paths].sort().map(async (path) => {
      const content = new Uint8Array(await readFile(join(root, path)));
      return {
        path,
        sha256: sha256(content),
        bytes: content.byteLength,
        media_type: mediaType(path),
      };
    }),
  );
}

function uniqueEvaluators(evaluations: EvaluationResponse[]): EvaluatorIdentity[] {
  const identities = new Map<string, EvaluatorIdentity>();
  for (const response of evaluations) {
    identities.set(canonicalJson(response.evaluator), response.evaluator);
  }
  return [...identities.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function uniqueSuites(evaluations: EvaluationResponse[]): EvaluationSuite[] {
  const suites = new Map<string, EvaluationSuite>();
  for (const response of evaluations) {
    suites.set(canonicalJson(response.suite), response.suite);
  }
  return [...suites.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function validatePublishedScores(
  evaluations: EvaluationResponse[],
  metricCards: MetricCard[],
): void {
  const cards = new Map<string, MetricCard>(
    metricCards.map((metric) => [`${metric.id}\0${metric.version}`, metric] as const),
  );
  for (const response of evaluations) {
    for (const score of response.scores) {
      if (score.value === undefined) {
        continue;
      }
      const identity = `${score.metric_id}\0${score.metric_version}`;
      const card = cards.get(identity);
      if (!card) {
        continue;
      }
      const validType =
        (card.value_type === "boolean" && typeof score.value === "boolean") ||
        (card.value_type === "string" &&
          typeof score.value === "string" &&
          (card.allowed_values ?? []).includes(score.value)) ||
        (["proportion", "count", "number"].includes(card.value_type) &&
          typeof score.value === "number" &&
          Number.isFinite(score.value));
      if (!validType) {
        throw new Error(
          `score ${score.metric_id}@${score.metric_version} does not satisfy its public value contract`,
        );
      }
      if (
        card.value_type === "proportion" &&
        typeof score.value === "number" &&
        (score.value < 0 || score.value > 1)
      ) {
        throw new Error(`proportion ${score.metric_id}@${score.metric_version} is outside [0, 1]`);
      }
      if (
        card.value_type === "count" &&
        typeof score.value === "number" &&
        (!Number.isInteger(score.value) || score.value < 0)
      ) {
        throw new Error(
          `count ${score.metric_id}@${score.metric_version} must be a non-negative integer`,
        );
      }
      if (
        card.valid_range !== undefined &&
        typeof score.value === "number" &&
        (score.value < card.valid_range.minimum || score.value > card.valid_range.maximum)
      ) {
        throw new Error(
          `score ${score.metric_id}@${score.metric_version} is outside its declared valid range`,
        );
      }
    }
  }
}

export async function exportRelease(options: ReleaseExportOptions): Promise<ReleaseExportResult> {
  validateReleaseIdentity(options);
  validateDesignation(options.release.designation);
  validateEvaluationHistory(options.evaluations, options.evaluationHistory);
  validateFormalRelease(options);
  if (
    typeof options.runManifest !== "object" ||
    options.runManifest === null ||
    Array.isArray(options.runManifest)
  ) {
    throw new Error("release requires a complete run manifest");
  }
  const metricCards = metricCardsSchema.parse({
    schema_version: "1",
    metrics: options.metricCards,
  });
  validatePublishedScores(options.evaluations, metricCards.metrics);
  const requiredMetricIds = new Set([
    "strict-acceptance\0" + "1",
    ...options.evaluations.flatMap((response) =>
      response.scores.map((score) => `${score.metric_id}\0${score.metric_version}`),
    ),
  ]);
  const documentedMetricIds = new Set(
    metricCards.metrics.map((metric) => `${metric.id}\0${metric.version}`),
  );
  const undocumentedMetricIds = [...requiredMetricIds].filter(
    (metricId) => !documentedMetricIds.has(metricId),
  );
  if (undocumentedMetricIds.length > 0) {
    throw new Error(
      `missing metric cards (id@version): ${undocumentedMetricIds
        .sort()
        .map((identity) => identity.replace("\0", "@"))
        .join(", ")}`,
    );
  }
  const evaluators = uniqueEvaluators(options.evaluations);
  const suites = uniqueSuites(options.evaluations);
  if (evaluators.length > 1 || suites.length > 1) {
    throw new Error(
      "one release analysis cannot mix evaluator or suite identities across attempts",
    );
  }
  const publishedSystems = attestedSystems(options.systems);
  await outputMustNotExist(options.outputDirectory);
  await mkdir(dirname(options.outputDirectory), { recursive: true });
  const temporaryDirectory = join(
    dirname(options.outputDirectory),
    `.${basename(options.outputDirectory)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  await mkdir(temporaryDirectory);

  try {
    const records = buildAnalysisRecords(options.generations, options.evaluations);
    const summary = summarizeEvaluation(options.generations, options.evaluations);
    const paths: string[] = [];
    const add = async (path: string, content: string): Promise<void> => {
      await writeText(temporaryDirectory, path, content);
      paths.push(path);
    };

    await add("data/attempts.jsonl", toJsonLines(records.attempts));
    await add(
      "data/attempts.csv",
      toCsv(
        ATTEMPT_COLUMNS.map((column) => column.name),
        records.attempts,
      ),
    );
    await add(
      "data/evaluations.jsonl",
      toJsonLines(
        [...options.evaluations]
          .sort((left, right) =>
            left.evaluation_id < right.evaluation_id
              ? -1
              : left.evaluation_id > right.evaluation_id
                ? 1
                : 0,
          )
          .map(publicEvaluation),
      ),
    );
    await add(
      "data/evaluation-history.jsonl",
      toJsonLines(options.evaluationHistory.map(publicEvaluation)),
    );
    await add("data/scores.jsonl", toJsonLines(records.scores));
    await add(
      "data/scores.csv",
      toCsv(
        SCORE_COLUMNS.map((column) => column.name),
        records.scores,
      ),
    );
    await add("analysis/summary.json", `${canonicalJson(summary)}\n`);
    await add("analysis/system-summary.json", `${canonicalJson(records.systems)}\n`);
    await add("analysis/paired-comparisons.jsonl", toJsonLines(records.pairs));
    const bootstrap = options.analysis;
    const plannedContrasts = bootstrap.contrasts ?? [];
    if (plannedContrasts.length > 1) {
      throw new Error(
        "release protocol v1 permits one confirmatory contrast; a larger family requires a preregistered multiplicity method",
      );
    }
    const contrastKeys = plannedContrasts.map(
      (contrast) => `${contrast.system_a}\0${contrast.system_b}`,
    );
    if (new Set(contrastKeys).size !== contrastKeys.length) {
      throw new Error("preregistered contrast plan contains duplicate directed contrasts");
    }
    const systemIds = new Set(records.systems.map((system) => system.system_id));
    const contrasts: PairedBootstrapResult[] = plannedContrasts.flatMap((plan, index) => {
      if (
        plan.system_a === plan.system_b ||
        !systemIds.has(plan.system_a) ||
        !systemIds.has(plan.system_b)
      ) {
        throw new Error(`invalid preregistered contrast ${plan.system_a} versus ${plan.system_b}`);
      }
      const storedA = plan.system_a < plan.system_b ? plan.system_a : plan.system_b;
      const storedB = plan.system_a < plan.system_b ? plan.system_b : plan.system_a;
      let comparison = records.pairs.filter(
        (row) => row.system_a === storedA && row.system_b === storedB,
      );
      if (plan.system_a !== storedA) {
        comparison = comparison.map((row) => ({
          ...row,
          system_a: plan.system_a,
          system_b: plan.system_b,
          strict_success_a: row.strict_success_b,
          strict_success_b: row.strict_success_a,
          quality_outcome_available_a: row.quality_outcome_available_b,
          quality_outcome_available_b: row.quality_outcome_available_a,
        }));
      }
      if (!comparison.some((row) => row.pair_complete)) {
        return [];
      }
      return [
        pairedCaseBootstrap(comparison, {
          seed: (bootstrap.bootstrapSeed + index) >>> 0,
          resamples: bootstrap.bootstrapResamples,
          ...(bootstrap.confidenceLevel === undefined
            ? {}
            : { confidenceLevel: bootstrap.confidenceLevel }),
        }),
      ];
    });
    await add("analysis/contrasts.json", `${canonicalJson(contrasts)}\n`);
    const systemIntervals: SystemBootstrapResult[] = records.systems.map((system, index) =>
      systemCaseBootstrap(
        records.attempts.filter((row) => row.system_id === system.system_id),
        {
          seed: (bootstrap.bootstrapSeed + plannedContrasts.length + index) >>> 0,
          resamples: bootstrap.bootstrapResamples,
          ...(bootstrap.confidenceLevel === undefined
            ? {}
            : { confidenceLevel: bootstrap.confidenceLevel }),
        },
      ),
    );
    await add("analysis/system-intervals.json", `${canonicalJson(systemIntervals)}\n`);
    await add("metadata/metric-cards.json", `${canonicalJson(metricCards)}\n`);
    await add(
      "metadata/run-provenance.json",
      `${canonicalJson(publicRunProvenance(options.runManifest))}\n`,
    );
    await add(
      "metadata/evidence-index.json",
      `${canonicalJson(publicEvidenceIndex(options.evaluationHistory))}\n`,
    );
    await add(
      "metadata/cases.json",
      `${canonicalJson({ schema_version: "1", cases: options.cases })}\n`,
    );
    await add(
      "metadata/systems.json",
      `${canonicalJson({ schema_version: "1", systems: publishedSystems })}\n`,
    );

    let files = await describeFiles(temporaryDirectory, paths);
    await add("metadata/croissant.json", `${canonicalJson(croissantMetadata(options, files))}\n`);
    files = await describeFiles(temporaryDirectory, paths);
    await add("ro-crate-metadata.json", `${canonicalJson(roCrateMetadata(options, files))}\n`);
    files = await describeFiles(temporaryDirectory, paths);
    const checksums = files.map((file) => `${file.sha256}  ${file.path}`).join("\n");
    await add("SHA256SUMS.txt", `${checksums}\n`);
    files = await describeFiles(temporaryDirectory, paths);

    const manifest = {
      schema_version: "1",
      release: {
        id: options.release.id,
        version: options.release.version,
        title: options.release.title,
        description: options.release.description,
        url: options.release.url,
        creators: options.release.creators,
        created_at: options.release.createdAt,
        license: options.release.license,
        designation: options.release.designation,
      },
      benchmark: {
        id: options.benchmark.id,
        plan_digest: options.benchmark.planDigest,
        dataset: {
          id: options.benchmark.datasetId,
          version: options.benchmark.datasetVersion,
          digest: options.benchmark.datasetDigest,
        },
        target: options.benchmark.target,
      },
      systems: publishedSystems,
      cases: options.cases.map(({ id, title, tags, digest }) => ({ id, title, tags, digest })),
      evaluators,
      evaluation_suites: suites,
      counts: {
        ...summary.denominators,
        evaluation_history_records: options.evaluationHistory.length,
        evaluation_retries: options.evaluationHistory.length - options.evaluations.length,
      },
      provenance: {
        disclosure_profile: {
          id: PUBLIC_DISCLOSURE_PROFILE.id,
          version: PUBLIC_DISCLOSURE_PROFILE.version,
        },
        run_provenance: "metadata/run-provenance.json",
        evidence_index: "metadata/evidence-index.json",
      },
      analysis: {
        method: bootstrap.method,
        estimand: bootstrap.estimand,
        interval: "percentile bootstrap with R type-7 quantiles",
        base_seed: bootstrap.bootstrapSeed,
        resamples: bootstrap.bootstrapResamples,
        confidence_level: bootstrap.confidenceLevel ?? 0.95,
        preregistered_contrasts: plannedContrasts,
        registration: bootstrap.registration ?? null,
        design: recordedAnalysisDesign(options.runManifest),
        inference_limitations: {
          cluster_count: new Set(options.generations.map((row) => row.case_id)).size,
          refinement: "none",
          coverage: CLUSTER_COVERAGE_LIMITATION,
          references: [...CLUSTER_INFERENCE_REFERENCES],
        },
      },
      files,
    };
    const manifestText = `${canonicalJson(manifest)}\n`;
    await add("release-manifest.json", manifestText);

    await rename(temporaryDirectory, options.outputDirectory);
    return {
      directory: options.outputDirectory,
      manifestDigest: sha256(manifestText),
      files,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
