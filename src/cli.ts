#!/usr/bin/env bun

import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { ZodError } from "zod";
import { artemisParametersSchema } from "../adapters/artemis/config.ts";
import { createArtemisEvaluationExecutor } from "../adapters/artemis/evaluation.ts";
import { publishSite } from "../site/publish.ts";
import { digestJson } from "./core/canonical.ts";
import { loadBenchmark } from "./core/load.ts";
import { createPlan } from "./core/plan.ts";
import { acquireRunCoordinatorLock, readRunSummary, runPlan } from "./core/run.ts";
import { requireSupportedToolchain } from "./core/toolchain.ts";
import { evaluationSuiteSchema, evaluatorIdentitySchema } from "./evaluation/contracts.ts";
import { evaluateCandidates } from "./evaluation/runner.ts";
import {
  builtInBundleEvaluatorIdentity,
  builtInDevelopmentSuite,
  executeBundleIntegrityEvaluation,
  loadEvaluationJournalForRelease,
  loadRunEvaluationSource,
} from "./evaluation/source.ts";
import { metricCardsSchema } from "./export/metric-card.ts";
import { exportRelease } from "./export/release.ts";
import { releaseMetadataFileSchema } from "./export/release-metadata.ts";
import { verifyRelease } from "./export/verify.ts";
import { EXGEN_VERSION } from "./version.ts";

requireSupportedToolchain();

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printSummary(summary: ReturnType<typeof readRunSummary>): void {
  const counts = Object.entries(summary.counts)
    .map(([state, count]) => `${state}=${count}`)
    .join(" ");
  process.stdout.write(
    `${summary.runId}: ${counts || "no attempts"} (${summary.total} total)\n${summary.directory}\n`,
  );
}

function setOperationalExitCode(summary: ReturnType<typeof readRunSummary>): void {
  if (summary.interrupted) {
    process.exitCode = 130;
    return;
  }
  if (
    (summary.counts.failed ?? 0) > 0 ||
    (summary.counts.cancelled ?? 0) > 0 ||
    (summary.counts.interrupted ?? 0) > 0
  ) {
    process.exitCode = 2;
  }
}

function defaultRunId(planId: string): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${planId.slice(0, 12)}`;
}

function validateRunId(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("run ID must use 1-128 letters, digits, '.', '_' or '-'");
  }
  return runId;
}

const program = new Command()
  .name("exgen")
  .description(
    "Run reproducible, approach-agnostic experiments on generated programming exercises.",
  )
  .version(EXGEN_VERSION)
  .showSuggestionAfterError()
  .showHelpAfterError();

program
  .command("validate")
  .description("Validate a benchmark, dataset, and all referenced briefs.")
  .requiredOption("-c, --config <path>", "benchmark YAML or JSON")
  .option("--json", "emit machine-readable output", false)
  .action(async (options) => {
    const loaded = await loadBenchmark(options.config);
    const plan = await createPlan(loaded);
    const result = {
      valid: true,
      benchmark: loaded.config.id,
      dataset: `${loaded.dataset.id}@${loaded.dataset.version}`,
      systems: loaded.config.systems.length,
      cases: loaded.dataset.cases.length,
      attempts: plan.attempts.length,
      plan_id: plan.id,
    };
    if (options.json) {
      printJson(result);
    } else {
      process.stdout.write(
        `Valid: ${result.benchmark} · ${result.dataset} · ${result.cases} cases · ${result.systems} systems · ${result.attempts} attempts\n`,
      );
    }
  });

program
  .command("plan")
  .description("Resolve and deterministically randomize an experiment without running it.")
  .requiredOption("-c, --config <path>", "benchmark YAML or JSON")
  .option("--json", "emit the complete resolved plan", false)
  .action(async (options) => {
    const loaded = await loadBenchmark(options.config);
    const plan = await createPlan(loaded);
    if (options.json) {
      printJson(plan);
      return;
    }
    process.stdout.write(
      `${[
        `Plan ${plan.id}`,
        `${plan.cases.length} cases × ${plan.systems.length} systems × ${plan.trials.replicates} replicates = ${plan.attempts.length} attempts`,
        "No model or generator was called.",
      ].join("\n")}\n`,
    );
  });

program
  .command("run")
  .description("Create a new immutable experiment run.")
  .requiredOption("-c, --config <path>", "benchmark YAML or JSON")
  .option("--run-id <id>", "human-facing run ID")
  .option("--json", "emit machine-readable summary", false)
  .action(async (options) => {
    const loaded = await loadBenchmark(options.config);
    const plan = await createPlan(loaded);
    const runId = validateRunId(options.runId ?? defaultRunId(plan.id));
    const resultsDirectory = resolve(loaded.configDirectory, loaded.config.execution.results_dir);
    const runDirectory = resolve(resultsDirectory, runId);
    await mkdir(resultsDirectory, { recursive: true });
    const summary = await runPlan(loaded, plan, runId, runDirectory, { create: true });
    options.json ? printJson(summary) : printSummary(summary);
    setOperationalExitCode(summary);
  });

program
  .command("resume")
  .description("Continue only the still-planned attempts of an existing run.")
  .argument("<run-directory>", "existing run directory")
  .requiredOption("-c, --config <path>", "the same benchmark YAML or JSON")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const loaded = await loadBenchmark(options.config);
    const plan = await createPlan(loaded);
    const runDirectory = resolve(runDirectoryInput);
    const runId = basename(runDirectory);
    const summary = await runPlan(loaded, plan, runId, runDirectory, { create: false });
    options.json ? printJson(summary) : printSummary(summary);
    setOperationalExitCode(summary);
  });

program
  .command("status")
  .description("Inspect the durable state of an experiment run.")
  .argument("<run-directory>", "existing run directory")
  .option("--json", "emit machine-readable summary", false)
  .action((runDirectory, options) => {
    const summary = readRunSummary(runDirectory);
    options.json ? printJson(summary) : printSummary(summary);
  });

program
  .command("verify-run")
  .description(
    "Reconcile the ledger, immutable observations, evidence manifests, and candidate digests.",
  )
  .argument("<run-directory>", "existing run directory")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectory, options) => {
    const source = await loadRunEvaluationSource(runDirectory);
    const result = {
      valid: true,
      run_id: source.runId,
      plan_id: source.planId,
      attempts: source.generations.length,
      candidates: source.candidates.length,
    };
    options.json
      ? printJson(result)
      : process.stdout.write(
          `${result.run_id}: ${result.attempts} attempts and ${result.candidates} candidates verified\n`,
        );
  });

program
  .command("evaluate")
  .description(
    "Run the development bundle-integrity evaluator; formal studies use a versioned external suite.",
  )
  .argument("<run-directory>", "existing generated run directory")
  .option("--journal <path>", "evaluation journal path")
  .option("--concurrency <count>", "parallel evaluations", "1")
  .option("--retry-infrastructure", "retry only prior evaluator infrastructure failures", false)
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = resolve(runDirectoryInput);
    const releaseLock = await acquireRunCoordinatorLock(runDirectory);
    try {
      const source = await loadRunEvaluationSource(runDirectory);
      const journalPath = resolve(
        options.journal ?? join(source.runDirectory, "evaluations", "bundle-integrity.jsonl"),
      );
      const evaluator = await builtInBundleEvaluatorIdentity(source.target);
      const suite = builtInDevelopmentSuite(source.target);
      const concurrency = Number.parseInt(options.concurrency, 10);
      const result = await evaluateCandidates({
        candidates: source.candidates,
        evaluator,
        suite,
        requestedMetrics: ["bundle.integrity"],
        journalPath,
        concurrency,
        retryInfrastructureFailures: options.retryInfrastructure,
        execute: (request) => executeBundleIntegrityEvaluation(request, source.target),
      });
      const output = {
        run_id: source.runId,
        evaluator: evaluator.id,
        suite: `${suite.id}@${suite.version}`,
        candidates: source.candidates.length,
        executed: result.executed,
        resumed: result.resumed,
        strict_successes: result.responses.filter((response) => response.strict_success === true)
          .length,
        journal: journalPath,
        warning:
          "development-smoke verifies bundle integrity only; it is not an independent study evaluator",
      };
      options.json
        ? printJson(output)
        : process.stdout.write(
            `${output.executed} evaluated, ${output.resumed} resumed · ${output.strict_successes}/${output.candidates} bundle-integrity successes\n${output.journal}\n${output.warning}\n`,
          );
    } finally {
      await releaseLock();
    }
  });

program
  .command("evaluate-artemis")
  .description("Evaluate successful candidates with a pinned, durable Artemis verifier.")
  .argument("<run-directory>", "existing generated run directory")
  .requiredOption("--parameters <path>", "Artemis verifier parameters JSON")
  .requiredOption("--evaluator-revision <revision>", "exact Artemis verifier revision")
  .requiredOption("--evaluator-digest <sha256>", "verifier implementation SHA-256")
  .requiredOption("--suite-id <id>", "independent evaluation suite ID")
  .requiredOption("--suite-version <version>", "independent evaluation suite version")
  .requiredOption("--suite-digest <sha256>", "evaluation suite SHA-256")
  .option("--evaluator-id <id>", "evaluator ID", "artemis-canonical")
  .option("--evaluator-version <version>", "evaluator protocol version", "1")
  .option("--profile <id>", "Artemis verifier profile", "artemis-default")
  .option("--metrics <ids>", "comma-separated metric IDs", "artemis.canonical_acceptance")
  .option("--journal <path>", "evaluation journal path")
  .option("--concurrency <count>", "parallel evaluations", "1")
  .option("--timeout-ms <milliseconds>", "per-candidate wall-time limit", "1800000")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = resolve(runDirectoryInput);
    const releaseLock = await acquireRunCoordinatorLock(runDirectory);
    try {
      const source = await loadRunEvaluationSource(runDirectory);
      const parameters = artemisParametersSchema.parse(
        JSON.parse(await readFile(resolve(options.parameters), "utf8")),
      );
      if (parameters.api_mode !== "research") {
        throw new Error(
          "formal Artemis evaluation requires api_mode=research; the legacy pilot is generation-only",
        );
      }
      const evaluator = evaluatorIdentitySchema.parse({
        id: options.evaluatorId,
        version: options.evaluatorVersion,
        revision: options.evaluatorRevision,
        target_profile: options.profile,
        implementation_digest: options.evaluatorDigest,
        configuration_digest: digestJson({
          parameters,
          profile: options.profile,
        }),
      });
      const suite = evaluationSuiteSchema.parse({
        id: options.suiteId,
        version: options.suiteVersion,
        digest: options.suiteDigest,
      });
      const requestedMetrics = [
        ...new Set(
          options.metrics
            .split(",")
            .map((metric) => metric.trim())
            .filter(Boolean),
        ),
      ].sort();
      if (requestedMetrics.length === 0) {
        throw new Error("--metrics must name at least one metric");
      }
      const concurrency = Number.parseInt(options.concurrency, 10);
      const timeoutMs = Number.parseInt(options.timeoutMs, 10);
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new Error("--concurrency must be a positive integer");
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      const journalPath = resolve(
        options.journal ??
          join(
            source.runDirectory,
            "evaluations",
            `${evaluator.id}-${suite.id}-${suite.version}.jsonl`,
          ),
      );
      const result = await evaluateCandidates({
        candidates: source.candidates,
        evaluator,
        suite,
        requestedMetrics,
        journalPath,
        concurrency,
        timeoutMs,
        retryInfrastructureFailures: false,
        execute: createArtemisEvaluationExecutor({
          parameters,
          evidenceRoot: join(source.runDirectory, "evaluations", "artemis-evidence"),
          target: source.target,
        }),
      });
      const output = {
        run_id: source.runId,
        evaluator,
        suite,
        candidates: source.candidates.length,
        executed: result.executed,
        resumed: result.resumed,
        strict_successes: result.responses.filter((response) => response.strict_success === true)
          .length,
        quality_failures: result.responses.filter(
          (response) => response.status === "quality_failed",
        ).length,
        infrastructure_failures: result.responses.filter(
          (response) => response.status === "infra_failed",
        ).length,
        journal: journalPath,
      };
      options.json
        ? printJson(output)
        : process.stdout.write(
            `${output.executed} evaluated, ${output.resumed} resumed · ${output.strict_successes} accepted · ${output.quality_failures} quality failures · ${output.infrastructure_failures} infrastructure failures\n${output.journal}\n`,
          );
    } finally {
      await releaseLock();
    }
  });

program
  .command("export")
  .description(
    "Create an immutable, checksummed scientific release from a run and evaluation journal.",
  )
  .argument("<run-directory>", "existing generated run directory")
  .requiredOption("--output <directory>", "new release output directory")
  .requiredOption("--metadata <path>", "release metadata JSON")
  .requiredOption("--metric-cards <path>", "versioned metric-card JSON")
  .option("--journal <path>", "evaluation journal path")
  .option("--json", "emit machine-readable output", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = resolve(runDirectoryInput);
    const releaseLock = await acquireRunCoordinatorLock(runDirectory);
    try {
      const source = await loadRunEvaluationSource(runDirectory);
      const journalPath = resolve(
        options.journal ?? join(source.runDirectory, "evaluations", "bundle-integrity.jsonl"),
      );
      const evaluationJournal = await loadEvaluationJournalForRelease(journalPath);
      const metricCards = metricCardsSchema.parse(
        JSON.parse(await readFile(resolve(options.metricCards), "utf8")),
      );
      const releaseMetadata = releaseMetadataFileSchema.parse(
        JSON.parse(await readFile(resolve(options.metadata), "utf8")),
      );
      const result = await exportRelease({
        outputDirectory: resolve(options.output),
        release: {
          ...releaseMetadata,
          createdAt: releaseMetadata.created_at,
        },
        benchmark: {
          id: source.benchmark.id,
          planDigest: source.planId,
          datasetId: source.dataset.id,
          datasetVersion: source.dataset.version,
          datasetDigest: source.dataset.digest,
          target: {
            id: source.target.id,
            version: source.target.version,
            revision: source.target.revision,
          },
        },
        systems: source.systems,
        cases: source.cases,
        metricCards: metricCards.metrics,
        runManifest: source.runManifest,
        generations: source.generations,
        evaluations: evaluationJournal.latest,
        evaluationHistory: evaluationJournal.history,
        analysis: {
          bootstrapSeed: source.runManifest.plan.analysis.bootstrap_seed,
          bootstrapResamples: source.runManifest.plan.analysis.bootstrap_resamples,
          confidenceLevel: source.runManifest.plan.analysis.confidence_level,
          contrasts: source.runManifest.plan.analysis.contrasts,
          ...(source.runManifest.plan.analysis.registration
            ? { registration: source.runManifest.plan.analysis.registration }
            : {}),
        },
      });
      options.json
        ? printJson(result)
        : process.stdout.write(
            `Release ${releaseMetadata.id}@${releaseMetadata.version}\n${result.directory}\nmanifest sha256 ${result.manifestDigest}\n`,
          );
    } finally {
      await releaseLock();
    }
  });

program
  .command("verify-release")
  .description("Verify every file size and SHA-256 digest in an immutable release.")
  .argument("<release-directory>", "release directory")
  .option("--json", "emit machine-readable output", false)
  .action(async (releaseDirectory, options) => {
    const result = await verifyRelease(releaseDirectory);
    options.json
      ? printJson(result)
      : process.stdout.write(
          `${result.releaseId}@${result.version}: ${result.files} files verified\nmanifest sha256 ${result.manifestSha256}\n`,
        );
  });

program
  .command("publish-site")
  .description("Build a self-contained static evidence explorer from a verified formal release.")
  .argument("<release-directory>", "verified formal release directory")
  .requiredOption("--output <directory>", "new static-site output directory")
  .option("--json", "emit machine-readable output", false)
  .action(async (releaseDirectory, options) => {
    const result = await publishSite({
      releaseDirectory,
      outputDirectory: options.output,
    });
    options.json
      ? printJson(result)
      : process.stdout.write(
          `Published ${result.releaseId} · ${result.attempts} planned attempts\n${result.directory}\n`,
        );
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof ZodError) {
    process.stderr.write(`Invalid benchmark contract:\n${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
