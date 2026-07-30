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
import type {
  EvaluationResponse,
  EvaluationSuite,
  EvaluatorIdentity,
} from "../evaluation/contracts.ts";
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
  systems: Array<{ id: string; name: string; version: string; revision: string }>;
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
  analysis?: {
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
  if (!options.analysis?.registration) {
    throw new Error("submitted releases require a frozen registration record");
  }
  if (
    options.cases.some(
      (datasetCase) =>
        datasetCase.origin === undefined ||
        datasetCase.authors === undefined ||
        datasetCase.authors.length === 0 ||
        datasetCase.license === undefined ||
        datasetCase.exposure === undefined,
    )
  ) {
    throw new Error(
      "formal releases require origin, authorship, license, and exposure records for every case",
    );
  }
  if (options.evaluations.length === 0) {
    throw new Error("submitted releases require independent evaluation outcomes");
  }
  if (options.evaluations.some((response) => response.evaluator.id === "bundle-integrity")) {
    throw new Error("the development bundle-integrity evaluator cannot support a formal release");
  }
  if (
    options.generations.some(
      (observation) => observation.state === "planned" || observation.state === "running",
    )
  ) {
    throw new Error("submitted releases require every planned attempt to be terminal");
  }
  if (
    options.generations.some(
      (observation) =>
        observation.state === "completed" &&
        observation.outcome === "succeeded" &&
        (observation.seed_status == null ||
          observation.effective_parameters_digest == null ||
          observation.provider_request_ids_digest == null ||
          observation.provider_request_ids_complete !== true),
    )
  ) {
    throw new Error(
      "formal releases require complete effective seed, decoding, and provider-request provenance",
    );
  }
  const generatedAttempts = new Set(
    options.generations
      .filter(
        (observation) => observation.state === "completed" && observation.outcome === "succeeded",
      )
      .map((observation) => observation.attempt_id),
  );
  const evaluatedAttempts = new Set(
    options.evaluations.map((response) => response.candidate.attempt_id),
  );
  if (
    generatedAttempts.size !== evaluatedAttempts.size ||
    [...generatedAttempts].some((attemptId) => !evaluatedAttempts.has(attemptId))
  ) {
    throw new Error("formal release evaluations do not cover every generated candidate");
  }
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
  if (
    options.release.designation.status !== "exploratory" &&
    metricCards.metrics.some(
      (metric) =>
        metric.validation.status !== "completed" || metric.validation.evidence.length === 0,
    )
  ) {
    throw new Error("submitted releases require completed metric validation with evidence");
  }
  const evaluators = uniqueEvaluators(options.evaluations);
  const suites = uniqueSuites(options.evaluations);
  if (evaluators.length > 1 || suites.length > 1) {
    throw new Error(
      "one release analysis cannot mix evaluator or suite identities across attempts",
    );
  }
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
        [
          "attempt_id",
          "case_id",
          "system_id",
          "replicate",
          "seed",
          "generation_key",
          "generation_state",
          "generation_outcome",
          "generation_error",
          "generation_started_at",
          "generation_finished_at",
          "artifact_digest",
          "evidence_digest",
          "generation_budget_status",
          "budget_violations",
          "budget_missing",
          "generation_duration_ms",
          "model_calls",
          "tool_calls",
          "input_tokens",
          "output_tokens",
          "total_tokens",
          "cost_amount",
          "cost_currency",
          "seed_status",
          "effective_parameters_digest",
          "provider_request_ids_digest",
          "provider_request_ids_complete",
          "evaluation_status",
          "evaluator_strict_success",
          "strict_success",
          "evaluation_failure",
        ],
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
        [
          "attempt_id",
          "case_id",
          "system_id",
          "replicate",
          "metric_id",
          "metric_version",
          "score_status",
          "value",
          "numerator",
          "denominator",
        ],
        records.scores,
      ),
    );
    await add("analysis/summary.json", `${canonicalJson(summary)}\n`);
    await add("analysis/system-summary.json", `${canonicalJson(records.systems)}\n`);
    await add("analysis/paired-comparisons.jsonl", toJsonLines(records.pairs));
    const bootstrap = options.analysis ?? {
      bootstrapSeed: 20_260_730,
      bootstrapResamples: 10_000,
    };
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
      `${canonicalJson({ schema_version: "1", systems: options.systems })}\n`,
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
      systems: options.systems,
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
        method: "case_clustered_paired_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate_difference",
        interval: "percentile bootstrap with R type-7 quantiles",
        base_seed: bootstrap.bootstrapSeed,
        resamples: bootstrap.bootstrapResamples,
        confidence_level: bootstrap.confidenceLevel ?? 0.95,
        preregistered_contrasts: plannedContrasts,
        registration: bootstrap.registration ?? null,
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
