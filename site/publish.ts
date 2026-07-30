import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson, sha256 } from "../src/core/canonical.ts";
import { toCsv, toJsonLines } from "../src/export/serialize.ts";
import { verifyRelease } from "../src/export/verify.ts";
import {
  type FormalReleaseStatus,
  formalReleaseDesignationSchema,
  publicReleaseSchema,
} from "./contracts.ts";

interface FormalAttempt {
  attempt_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  generation_state: string;
  generation_outcome: string | null;
  generation_error: string | null;
  evaluation_status: string | null;
  evaluator_strict_success: boolean | null;
  strict_success: boolean | null;
  generation_budget_status: "compliant" | "exceeded" | "unverifiable" | null;
  evaluation_failure: string | null;
}

interface PublicAttempt {
  observation_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  lifecycle: string;
  outcome:
    | "accepted"
    | "quality_failed"
    | "abstained"
    | "generation_failed"
    | "budget_exceeded"
    | "budget_unverifiable"
    | "infrastructure_failed"
    | "not_started";
  strict_accepted: boolean | null;
  evaluator_strict_accepted?: boolean | null;
  generation_completed: boolean;
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

function disposition(attempt: FormalAttempt): PublicAttempt["outcome"] {
  if (attempt.generation_state === "planned") {
    return "not_started";
  }
  const generated =
    attempt.generation_state === "completed" && attempt.generation_outcome === "succeeded";
  if (attempt.generation_state === "completed" && attempt.generation_outcome === "abstained") {
    return "abstained";
  }
  if (attempt.generation_outcome === "infra_failed") {
    return "infrastructure_failed";
  }
  if (attempt.generation_state === "completed" && attempt.generation_outcome !== "succeeded") {
    return "generation_failed";
  }
  if (generated && attempt.generation_budget_status === "exceeded") {
    return "budget_exceeded";
  }
  if (generated && attempt.generation_budget_status === "unverifiable") {
    return "budget_unverifiable";
  }
  const evaluatorStrictSuccess = attempt.evaluator_strict_success ?? attempt.strict_success;
  if (
    generated &&
    attempt.generation_budget_status === "compliant" &&
    attempt.evaluation_status === "succeeded" &&
    evaluatorStrictSuccess === true
  ) {
    return "accepted";
  }
  if (
    generated &&
    attempt.evaluation_status === "quality_failed" &&
    evaluatorStrictSuccess === false
  ) {
    return "quality_failed";
  }
  return "infrastructure_failed";
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

function systemColor(index: number): string {
  return ["#12664f", "#386cb0", "#d57a2a", "#7a5195", "#b64a5a"][index % 5] ?? "#252f2c";
}

function booleanGateStatus(values: Array<{ status: string; value?: unknown }>): string {
  if (values.length === 0) {
    return "not_measured";
  }
  const passed = values.filter((value) => value.status === "ok" && value.value === true).length;
  if (passed === values.length) {
    return "passed";
  }
  return passed === 0 ? "failed" : "mixed";
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
    const outcome = disposition(attempt);
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
    };
  });
  const systemMetadata = await readJson<{
    systems: Array<{
      id: string;
      name: string;
      version: string;
      revision: string;
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
  const evaluations = parseJsonLines<{
    candidate: { case_id: string; system_id: string };
    strict_success: boolean | null;
    scores: Array<{ metric_id: string; status: string; value?: unknown }>;
  }>(await readFile(join(releaseDirectory, "data", "evaluations.jsonl"), "utf8"));

  const systems = systemMetadata.systems.map((metadata, index) => {
    const rows = publicAttempts.filter((attempt) => attempt.system_id === metadata.id);
    const interval = intervals.find((candidate) => candidate.system_id === metadata.id);
    if (!interval) {
      throw new Error(`release has no system interval for ${metadata.id}`);
    }
    const planned = rows.length;
    const notStarted = countOutcome(rows, "not_started");
    const started = planned - notStarted;
    const accepted = countOutcome(rows, "accepted");
    return {
      id: metadata.id,
      name: metadata.name,
      description: `${metadata.version} · ${metadata.revision}`,
      color: systemColor(index),
      symbol: index % 2 === 0 ? "circle" : "square",
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
    const caseEvaluations = evaluations.filter(
      (evaluation) => evaluation.candidate.case_id === metadata.id,
    );
    const gates = systems.flatMap((system) => {
      const systemEvaluations = caseEvaluations.filter(
        (evaluation) => evaluation.candidate.system_id === system.id,
      );
      const strictValues = systemEvaluations
        .filter((evaluation) => evaluation.strict_success !== null)
        .map((evaluation) => ({
          status: evaluation.strict_success === true ? "ok" : "quality_failure",
          value: evaluation.strict_success ?? undefined,
        }));
      const booleanMetricIds = [
        ...new Set(
          systemEvaluations.flatMap((evaluation) =>
            evaluation.scores
              .filter((score) => typeof score.value === "boolean")
              .map((score) => score.metric_id),
          ),
        ),
      ].sort();
      return [
        [`${system.name} · strict acceptance`, booleanGateStatus(strictValues)],
        ...booleanMetricIds.map((metricId) => [
          `${system.name} · ${metricId}`,
          booleanGateStatus(
            systemEvaluations.flatMap((evaluation) =>
              evaluation.scores.filter(
                (score) => score.metric_id === metricId && typeof score.value === "boolean",
              ),
            ),
          ),
        ]),
      ];
    });
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
      gates: Object.fromEntries(gates),
      evidence_status:
        "This public view exposes normalized verdicts and allowlisted evidence references; generated source and restricted diagnostics remain in the archived research artifact.",
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
      budget: "Frozen in the checksummed source release manifest and run provenance",
    },
    systems,
    execution_coverage: [
      {
        id: "planned",
        label: "Planned",
        count: publicAttempts.length,
        color: "#8a938f",
      },
      {
        id: "started",
        label: "Started",
        count: publicAttempts.length - countOutcome(publicAttempts, "not_started"),
        color: "#6f8179",
      },
      {
        id: "completed",
        label: "Completed generation",
        count: publicAttempts.filter((attempt) => attempt.generation_completed).length,
        color: "#d57a2a",
      },
    ],
    final_dispositions: [
      {
        id: "accepted",
        label: "Strictly accepted",
        count: countOutcome(publicAttempts, "accepted"),
        color: "#12664f",
      },
      {
        id: "quality_failed",
        label: "Quality failed",
        count: countOutcome(publicAttempts, "quality_failed"),
        color: "#b64a5a",
      },
      {
        id: "abstained",
        label: "Abstained",
        count: countOutcome(publicAttempts, "abstained"),
        color: "#8a938f",
      },
      {
        id: "generation_failed",
        label: "Generation failed",
        count: countOutcome(publicAttempts, "generation_failed"),
        color: "#7a5195",
      },
      {
        id: "budget_exceeded",
        label: "Budget exceeded",
        count: countOutcome(publicAttempts, "budget_exceeded"),
        color: "#8d5a1e",
      },
      {
        id: "budget_unverifiable",
        label: "Budget unverifiable",
        count: countOutcome(publicAttempts, "budget_unverifiable"),
        color: "#6b7280",
      },
      {
        id: "infrastructure_failed",
        label: "Infrastructure failed",
        count: countOutcome(publicAttempts, "infrastructure_failed"),
        color: "#252f2c",
      },
      {
        id: "not_started",
        label: "Not started",
        count: countOutcome(publicAttempts, "not_started"),
        color: "#c2c8c5",
      },
    ],
    primary_contrast:
      primary === undefined
        ? null
        : {
            system_a: primary.system_a,
            system_b: primary.system_b,
            estimate: primary.observed_difference,
            interval_low: primary.confidence_interval[0],
            interval_high: primary.confidence_interval[1],
            unit: "percentage-point risk difference",
            method: `${primary.method.replaceAll("_", " ")} ${(primary.confidence_level * 100).toFixed(0)}% interval`,
            note: `${primary.cases} cases; ${primary.resamples} deterministic resamples. The interval preserves case clustering and the planned-attempt estimand.`,
          },
    cases,
    metrics: metricCards.metrics,
    limitations: [
      "Results apply to the frozen cases, budgets, target revision, evaluator suite, and system revisions in this release.",
      "Strict technical acceptance does not replace expert assessment of pedagogical quality.",
      "Infrastructure failures, generation failures, abstentions, and unstarted attempts remain explicit and count as zero in the confirmatory end-to-end estimand.",
      "Secondary metrics are interpreted according to their metric cards and are not combined into a composite leaderboard.",
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
        description: `CSV · ${publicAttempts.length} planned observations`,
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
    await mkdir(join(temporaryDirectory, "data", manifest.release.id), {
      recursive: true,
    });
    for (const file of ["index.html", "styles.css", "app.js"]) {
      await cp(join(sourceDirectory, file), join(temporaryDirectory, file));
    }
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
