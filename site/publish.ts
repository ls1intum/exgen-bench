import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson, sha256 } from "../src/core/canonical.ts";
import { toCsv, toJsonLines } from "../src/export/serialize.ts";
import { verifyRelease } from "../src/export/verify.ts";
import { assignApproachColors } from "./approach-colors.ts";
import {
  classifyPublicOutcome,
  type PublicAttemptClassificationInput,
  type PublicAttemptOutcome,
} from "./attempt-outcome.ts";
import { buildStaticSite } from "./build.ts";
import {
  type FormalReleaseStatus,
  formalReleaseDesignationSchema,
  publicReleaseSchema,
} from "./contracts.ts";

interface FormalAttempt extends PublicAttemptClassificationInput {
  attempt_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  generation_error: string | null;
  evaluation_failure: string | null;
  generation_duration_ms: number | null;
  cost_amount: number | null;
  cost_currency: string | null;
}

interface PublicAttempt {
  observation_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  lifecycle: string;
  outcome: PublicAttemptOutcome;
  strict_accepted: boolean | null;
  evaluator_strict_accepted?: boolean | null;
  generation_completed: boolean;
  cost_usd?: number;
  generation_duration_seconds?: number;
}

interface SystemInterval {
  system_id: string;
  method: string;
  observed_rate: number;
  confidence_interval: [number, number];
  confidence_level: number;
  resamples: number;
}

interface Contrast {
  system_a: string;
  system_b: string;
  method: string;
  observed_difference: number;
  confidence_interval: [number, number];
  confidence_level: number;
  resamples: number;
  cases: number;
}

interface FormalDesignation {
  status: FormalReleaseStatus;
}

const PUBLIC_SOURCE_FILES = [
  "data/scores.csv",
  "data/scores.jsonl",
  "analysis/summary.json",
  "analysis/system-summary.json",
  "analysis/paired-comparisons.jsonl",
  "analysis/contrasts.json",
  "analysis/system-intervals.json",
] as const;

function parseJsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function strictValue(outcome: PublicAttempt["outcome"]): boolean | null {
  if (outcome === "accepted") {
    return true;
  }
  if (
    [
      "quality_failed",
      "abstained",
      "generation_failed",
      "budget_exceeded",
      "budget_unverifiable",
    ].includes(outcome)
  ) {
    return false;
  }
  return null;
}

function countOutcome(attempts: PublicAttempt[], outcome: PublicAttempt["outcome"]): number {
  return attempts.filter((attempt) => attempt.outcome === outcome).length;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[midpoint - 1] ?? 0) + (ordered[midpoint] ?? 0)) / 2
    : (ordered[midpoint] ?? 0);
}

async function outputMustNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`site output already exists: ${path}`);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function publishSite(options: {
  releaseDirectory: string;
  outputDirectory: string;
  publicUrl?: string;
  sourceDirectory?: string;
}): Promise<{
  directory: string;
  releaseId: string;
  releaseVersion: string;
  status: FormalReleaseStatus;
  attempts: number;
}> {
  const releaseDirectory = resolve(options.releaseDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const sourceDirectory = resolve(options.sourceDirectory ?? import.meta.dir);
  await verifyRelease(releaseDirectory);
  await outputMustNotExist(outputDirectory);

  const manifestText = await readFile(join(releaseDirectory, "release-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    release: {
      id: string;
      version: string;
      title: string;
      description?: string;
      created_at: string;
      license: string;
      designation: FormalDesignation;
    };
    benchmark: {
      id: string;
      plan_digest: string;
      dataset: { id: string; version: string; digest: string };
      target: { id: string; version: string; revision: string };
    };
    evaluators: Array<{ id: string; version: string; revision: string }>;
    evaluation_suites: Array<{ id: string; version: string; digest: string }>;
    analysis: {
      method: string;
      estimand: string;
      base_seed: number;
      resamples: number;
      confidence_level: number;
    };
  };
  const designation = formalReleaseDesignationSchema.parse(manifest.release.designation);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(manifest.release.id)) {
    throw new Error("release ID is unsafe for a publication path");
  }
  const attempts = parseJsonLines<FormalAttempt>(
    await readFile(join(releaseDirectory, "data", "attempts.jsonl"), "utf8"),
  );
  const publicAttempts: PublicAttempt[] = attempts.map((attempt) => {
    const outcome = classifyPublicOutcome(attempt);
    const costUsd =
      attempt.generation_state === "planned"
        ? 0
        : attempt.cost_amount !== null && attempt.cost_currency?.toUpperCase() === "USD"
          ? attempt.cost_amount
          : undefined;
    const generationDurationSeconds =
      attempt.generation_duration_ms === null ? undefined : attempt.generation_duration_ms / 1_000;
    return {
      observation_id: attempt.attempt_id,
      case_id: attempt.case_id,
      system_id: attempt.system_id,
      replicate: attempt.replicate,
      lifecycle: attempt.generation_state,
      outcome,
      strict_accepted: strictValue(outcome),
      evaluator_strict_accepted: attempt.evaluator_strict_success,
      generation_completed: attempt.generation_state === "completed",
      ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
      ...(generationDurationSeconds === undefined
        ? {}
        : { generation_duration_seconds: generationDurationSeconds }),
    };
  });
  const systemMetadata = await readJson<{
    systems: Array<{
      id: string;
      name: string;
      version: string;
      revision: string;
      factors?: Record<string, string | number | boolean | null>;
    }>;
  }>(join(releaseDirectory, "metadata", "systems.json"));
  const caseMetadata = await readJson<{
    cases: Array<{
      id: string;
      title: string;
      tags: string[];
      brief: string;
      digest: string;
    }>;
  }>(join(releaseDirectory, "metadata", "cases.json"));
  const metricCards = await readJson<{ metrics: unknown[] }>(
    join(releaseDirectory, "metadata", "metric-cards.json"),
  );
  const intervals = await readJson<SystemInterval[]>(
    join(releaseDirectory, "analysis", "system-intervals.json"),
  );
  const contrasts = await readJson<Contrast[]>(
    join(releaseDirectory, "analysis", "contrasts.json"),
  );
  const approaches = systemMetadata.systems.map((metadata) =>
    String(metadata.factors?.approach ?? "Unspecified"),
  );
  const approachColors = assignApproachColors(approaches);
  const systems = systemMetadata.systems.map((metadata) => {
    const approach = String(metadata.factors?.approach ?? "Unspecified");
    const color = approachColors.get(approach);
    if (!color) throw new Error(`release has no presentation color for approach ${approach}`);
    const rows = publicAttempts.filter((attempt) => attempt.system_id === metadata.id);
    const interval = intervals.find((candidate) => candidate.system_id === metadata.id);
    if (!interval) {
      throw new Error(`release has no system interval for ${metadata.id}`);
    }
    const planned = rows.length;
    const notStarted = countOutcome(rows, "not_started");
    const started = planned - notStarted;
    const accepted = countOutcome(rows, "accepted");
    const costs = rows.flatMap((attempt) =>
      attempt.cost_usd === undefined ? [] : [attempt.cost_usd],
    );
    const startedRows = rows.filter((attempt) => attempt.lifecycle !== "planned");
    const durations = startedRows.flatMap((attempt) =>
      attempt.generation_duration_seconds === undefined
        ? []
        : [attempt.generation_duration_seconds],
    );
    const cost =
      costs.length === planned
        ? {
            estimate: mean(costs),
            currency: "USD" as const,
            statistic: "mean per planned attempt" as const,
            denominator: planned,
            pricing_basis: "Recorded USD cost_amount in the checksummed source release",
          }
        : undefined;
    const latency =
      startedRows.length > 0 && durations.length === startedRows.length
        ? {
            estimate: median(durations),
            unit: "seconds" as const,
            statistic: "median among started attempts" as const,
            denominator: startedRows.length,
          }
        : undefined;
    return {
      id: metadata.id,
      name: metadata.name,
      description: `${metadata.version} · ${metadata.revision}`,
      factors: metadata.factors ?? {},
      color,
      planned,
      started,
      completed: rows.filter((attempt) => attempt.generation_completed).length,
      accepted,
      quality_failed: countOutcome(rows, "quality_failed"),
      abstained: countOutcome(rows, "abstained"),
      generation_failed: countOutcome(rows, "generation_failed"),
      budget_exceeded: countOutcome(rows, "budget_exceeded"),
      budget_unverifiable: countOutcome(rows, "budget_unverifiable"),
      infrastructure_failed: countOutcome(rows, "infrastructure_failed"),
      not_started: notStarted,
      ...(cost || latency
        ? {
            decision_metrics: {
              ...(cost ? { cost } : {}),
              ...(latency ? { latency } : {}),
            },
          }
        : {}),
      primary: {
        estimate: accepted / planned,
        numerator: accepted,
        denominator: planned,
        interval_low: interval.confidence_interval[0],
        interval_high: interval.confidence_interval[1],
        interval_method: `${interval.method.replaceAll("_", " ")} ${(interval.confidence_level * 100).toFixed(0)}% interval · ${interval.resamples} resamples`,
        planned_sensitivity: accepted / planned,
        started_sensitivity: started === 0 ? null : accepted / started,
      },
    };
  });

  const cases = caseMetadata.cases.map((metadata) => {
    return {
      id: metadata.id,
      title: metadata.title,
      brief: metadata.brief,
      tags: metadata.tags,
      systems: Object.fromEntries(
        systems.map((system) => {
          const rows = publicAttempts.filter(
            (attempt) => attempt.case_id === metadata.id && attempt.system_id === system.id,
          );
          return [
            system.id,
            {
              accepted: countOutcome(rows, "accepted"),
              denominator: rows.length,
              quality_failed: countOutcome(rows, "quality_failed"),
              abstained: countOutcome(rows, "abstained"),
              generation_failed: countOutcome(rows, "generation_failed"),
              budget_exceeded: countOutcome(rows, "budget_exceeded"),
              budget_unverifiable: countOutcome(rows, "budget_unverifiable"),
              infrastructure_failed: countOutcome(rows, "infrastructure_failed"),
              not_started: countOutcome(rows, "not_started"),
            },
          ];
        }),
      ),
    };
  });

  const primary = contrasts[0];
  const publicRelease = {
    schema_version: "1",
    release_id: manifest.release.id,
    release_version: manifest.release.version,
    source_manifest_sha256: sha256(manifestText),
    title: manifest.release.title,
    status: designation.status,
    designation,
    published_at: manifest.release.created_at.slice(0, 10),
    summary:
      manifest.release.description ??
      `Frozen results for ${manifest.benchmark.id} on ${manifest.benchmark.dataset.id}@${manifest.benchmark.dataset.version}.`,
    notice:
      "Exploratory frozen release. Interpret estimates only for the recorded target, dataset, systems, evaluator, and analysis plan.",
    scope: {
      target: `${manifest.benchmark.target.id}@${manifest.benchmark.target.version}:${manifest.benchmark.target.revision}`,
      dataset: `${manifest.benchmark.dataset.id}@${manifest.benchmark.dataset.version}`,
      cases: cases.length,
      systems: systems.length,
      planned_attempts: publicAttempts.length,
      budget: "Recorded in the verified source release manifest and run details",
    },
    systems,
    primary_contrast:
      primary === undefined
        ? null
        : {
            system_a: primary.system_a,
            system_b: primary.system_b,
            estimate: primary.observed_difference,
            interval_low: primary.confidence_interval[0],
            interval_high: primary.confidence_interval[1],
            unit: "proportion risk difference",
            method: `${primary.method.replaceAll("_", " ")} ${(primary.confidence_level * 100).toFixed(0)}% interval`,
            note: `${primary.cases} cases; ${primary.resamples} fixed resamples. The interval resamples whole cases and covers all planned attempts.`,
          },
    cases,
    metrics: metricCards.metrics,
    limitations: [
      "Results apply to the frozen cases, budgets, target revision, evaluator suite, and system revisions in this release.",
      "Passing the technical evaluation does not replace expert assessment of educational quality.",
      "Service failures, generation failures, abstentions, and unstarted attempts remain visible and count as zero in the primary success rate.",
      "Secondary measures retain their individual definitions and are not combined into one score.",
    ],
    provenance: {
      release_schema: "public-release-v1",
      release_version: manifest.release.version,
      source_manifest_sha256: sha256(manifestText),
      designation: designation.status,
      benchmark: manifest.benchmark.id,
      plan_digest: manifest.benchmark.plan_digest,
      dataset_digest: manifest.benchmark.dataset.digest,
      evaluator: manifest.evaluators
        .map((evaluator) => `${evaluator.id}@${evaluator.version}:${evaluator.revision}`)
        .join(", "),
      suite: manifest.evaluation_suites
        .map((suite) => `${suite.id}@${suite.version}:${suite.digest}`)
        .join(", "),
      analysis: `${manifest.analysis.method}; seed ${manifest.analysis.base_seed}; ${manifest.analysis.resamples} resamples`,
      ...(systems.some((system) => system.decision_metrics?.cost)
        ? { pricing: "Recorded USD cost_amount in the checksummed source release" }
        : {}),
      license: manifest.release.license,
      reproduction: "All browser estimates are precomputed in the checksummed source release",
    },
    downloads: [
      {
        id: "release_json",
        label: "Public release manifest",
        description: "JSON · complete page input",
        path: "./release.json",
      },
      {
        id: "attempts_csv",
        label: "Attempt table",
        description: `CSV · ${publicAttempts.length} planned attempts`,
        path: "./attempts.csv",
      },
      {
        id: "attempts_jsonl",
        label: "Attempt records",
        description: "JSONL · audit-friendly",
        path: "./attempts.jsonl",
      },
      {
        id: "checksums",
        label: "Public checksums",
        description: "SHA-256 · public view files",
        path: "./checksums.txt",
      },
      {
        id: "scores_csv",
        label: "Score table",
        description: "CSV · allowlisted metric observations",
        path: "./source/data/scores.csv",
      },
      {
        id: "contrasts_json",
        label: "Contrast estimates",
        description: "JSON · precomputed case-clustered comparisons",
        path: "./source/analysis/contrasts.json",
      },
      {
        id: "system_intervals_json",
        label: "System intervals",
        description: "JSON · precomputed case-clustered intervals",
        path: "./source/analysis/system-intervals.json",
      },
    ],
  };

  await mkdir(dirname(outputDirectory), { recursive: true });
  const temporaryDirectory = join(
    dirname(outputDirectory),
    `.${basename(outputDirectory)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await buildStaticSite({
      outputDirectory: temporaryDirectory,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      sourceDirectory,
    });
    await mkdir(join(temporaryDirectory, "data", manifest.release.id), {
      recursive: true,
    });
    const publicDirectory = join(temporaryDirectory, "data", manifest.release.id);
    const releaseText = `${canonicalJson(publicReleaseSchema.parse(publicRelease))}\n`;
    const attemptsText = toJsonLines(publicAttempts);
    const attemptsCsv = toCsv(
      [
        "observation_id",
        "case_id",
        "system_id",
        "replicate",
        "lifecycle",
        "outcome",
        "strict_accepted",
        "evaluator_strict_accepted",
        "generation_completed",
        "cost_usd",
        "generation_duration_seconds",
      ],
      publicAttempts,
    );
    await writeFile(join(publicDirectory, "release.json"), releaseText, {
      flag: "wx",
    });
    await writeFile(join(publicDirectory, "attempts.jsonl"), attemptsText, {
      flag: "wx",
    });
    await writeFile(join(publicDirectory, "attempts.csv"), attemptsCsv, {
      flag: "wx",
    });
    for (const relativePath of PUBLIC_SOURCE_FILES) {
      const destination = join(publicDirectory, "source", relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(releaseDirectory, relativePath), destination);
    }
    const checksumPaths = [
      "release.json",
      "attempts.csv",
      "attempts.jsonl",
      ...PUBLIC_SOURCE_FILES.map((path) => `source/${path}`),
    ];
    const checksums = (
      await Promise.all(
        checksumPaths.map(async (path) => [
          sha256(new Uint8Array(await readFile(join(publicDirectory, path)))),
          path,
        ]),
      )
    )
      .map(([digest, path]) => `${digest}  ${path}`)
      .join("\n");
    await writeFile(join(publicDirectory, "checksums.txt"), `${checksums}\n`, {
      flag: "wx",
    });
    await writeFile(
      join(temporaryDirectory, "data", "catalog.json"),
      `${canonicalJson({
        schema_version: "1",
        releases: [
          {
            id: manifest.release.id,
            label: `${manifest.release.title} · ${manifest.release.version}`,
            manifest: `./${manifest.release.id}/release.json`,
            status: designation.status,
          },
        ],
        default_release_id: manifest.release.id,
      })}\n`,
      { flag: "wx" },
    );
    await rename(temporaryDirectory, outputDirectory);
    return {
      directory: outputDirectory,
      releaseId: manifest.release.id,
      releaseVersion: manifest.release.version,
      status: designation.status,
      attempts: publicAttempts.length,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
