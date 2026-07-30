#!/usr/bin/env bun

import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { ZodError } from "zod";
import { artemisParametersSchema } from "../adapters/artemis/config.ts";
import { createArtemisEvaluationExecutor } from "../adapters/artemis/evaluation.ts";
import { buildStaticSite } from "../site/build.ts";
import { publishSite } from "../site/publish.ts";
import { serveSite } from "../site/serve.ts";
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

async function requireRunDirectory(input: string): Promise<string> {
  const directory = resolve(input);
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) {
      throw new Error(`run path is not a directory: ${directory}`);
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `run directory does not exist: ${directory}\nCreate it with: exgen run <benchmark> --id ${basename(directory)}`,
      );
    }
    throw error;
  }
  for (const file of ["manifest.json", "ledger.sqlite"]) {
    try {
      if (!(await stat(join(directory, file))).isFile()) {
        throw new Error(`run directory contains a non-file ${file}: ${directory}`);
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new Error(`not an exgen run directory (missing ${file}): ${directory}`);
      }
      throw error;
    }
  }
  return directory;
}

function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("integer is outside the supported range");
  }
  return parsed;
}

function portNumber(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > 65_535) {
    throw new InvalidArgumentError("port must be between 1 and 65535");
  }
  return parsed;
}

const program = new Command()
  .name("exgen")
  .description(
    "Run reproducible, approach-agnostic experiments on generated programming exercises.",
  )
  .version(EXGEN_VERSION)
  .showSuggestionAfterError()
  .showHelpAfterError();

program.hook("preAction", () => requireSupportedToolchain());

program
  .command("validate")
  .description("Validate a benchmark, dataset, and all referenced briefs.")
  .argument("<benchmark>", "benchmark YAML or JSON")
  .option("--json", "emit machine-readable output", false)
  .action(async (benchmark, options) => {
    const loaded = await loadBenchmark(benchmark);
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
  .argument("<benchmark>", "benchmark YAML or JSON")
  .option("--json", "emit the complete resolved plan", false)
  .action(async (benchmark, options) => {
    const loaded = await loadBenchmark(benchmark);
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
  .description("Create a new experiment run.")
  .argument("<benchmark>", "benchmark YAML or JSON")
  .option("-i, --id <id>", "human-facing run ID")
  .option("--json", "emit machine-readable summary", false)
  .action(async (benchmark, options) => {
    const loaded = await loadBenchmark(benchmark);
    const plan = await createPlan(loaded);
    const runId = validateRunId(options.id ?? defaultRunId(plan.id));
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
  .requiredOption("-b, --benchmark <path>", "the same benchmark YAML or JSON")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const loaded = await loadBenchmark(options.benchmark);
    const plan = await createPlan(loaded);
    const runDirectory = await requireRunDirectory(runDirectoryInput);
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
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
    const summary = readRunSummary(runDirectory);
    options.json ? printJson(summary) : printSummary(summary);
  });

program
  .command("verify")
  .description(
    "Reconcile the ledger, content-addressed observations, evidence manifests, and candidate digests.",
  )
  .argument("<run-directory>", "existing run directory")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
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

const evaluationCommands = program
  .command("evaluate")
  .description("Evaluate generated candidates with a versioned evaluator.");

evaluationCommands
  .command("bundle")
  .description(
    "Run the development bundle-integrity evaluator; formal studies use a versioned external suite.",
  )
  .argument("<run-directory>", "existing generated run directory")
  .option("--journal <path>", "evaluation journal path")
  .option("--concurrency <count>", "parallel evaluations", positiveInteger, 1)
  .option("--retry-infrastructure", "retry only prior evaluator infrastructure failures", false)
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
    const releaseLock = await acquireRunCoordinatorLock(runDirectory);
    try {
      const source = await loadRunEvaluationSource(runDirectory);
      const journalPath = resolve(
        options.journal ?? join(source.runDirectory, "evaluations", "bundle-integrity.jsonl"),
      );
      const evaluator = await builtInBundleEvaluatorIdentity(source.target);
      const suite = builtInDevelopmentSuite(source.target);
      const result = await evaluateCandidates({
        candidates: source.candidates,
        evaluator,
        suite,
        requestedMetrics: ["bundle.integrity"],
        journalPath,
        concurrency: options.concurrency,
        retryInfrastructureFailures: options.retryInfrastructure,
        execute: executeBundleIntegrityEvaluation,
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

evaluationCommands
  .command("artemis")
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
  .option("--concurrency <count>", "parallel evaluations", positiveInteger, 1)
  .option(
    "--timeout-ms <milliseconds>",
    "per-candidate wall-time limit",
    positiveInteger,
    1_800_000,
  )
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
    const releaseLock = await acquireRunCoordinatorLock(runDirectory);
    try {
      const source = await loadRunEvaluationSource(runDirectory);
      const parameters = artemisParametersSchema.parse(
        JSON.parse(await readFile(resolve(options.parameters), "utf8")),
      );
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
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
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

const releaseCommands = program
  .command("release")
  .description("Create and verify versioned research releases.");

releaseCommands
  .command("create")
  .description("Create a checksummed research release from a run and evaluation journal.")
  .argument("<run-directory>", "existing generated run directory")
  .requiredOption("--output <directory>", "new release output directory")
  .requiredOption("--metadata <path>", "release metadata JSON")
  .requiredOption("--metric-cards <path>", "versioned metric-card JSON")
  .option("--journal <path>", "evaluation journal path")
  .option("--json", "emit machine-readable output", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
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

releaseCommands
  .command("verify")
  .description("Verify every file size and SHA-256 digest in a release.")
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

const siteCommands = program
  .command("site")
  .description("Build or preview the static results dashboard.");

siteCommands
  .command("build")
  .description("Build a self-contained results dashboard from a verified release.")
  .argument("<release-directory>", "verified release directory")
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
          `Built ${result.releaseId} · ${result.attempts} planned attempts\n${result.directory}\n`,
        );
  });

siteCommands
  .command("serve")
  .description("Preview a static results dashboard locally.")
  .argument("[directory]", "built site directory")
  .option("-p, --port <number>", "HTTP port", portNumber, 4173)
  .action(async (directory, options) => {
    const root =
      directory ??
      (await buildStaticSite({
        outputDirectory: resolve(import.meta.dir, "../site/dist"),
        includeDemoData: true,
      }));
    const server = serveSite(root, options.port);
    process.stdout.write(`Results dashboard: ${server.url}\n`);
    await new Promise<void>(() => {});
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof ZodError) {
    process.stderr.write(`Validation failed:\n${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
