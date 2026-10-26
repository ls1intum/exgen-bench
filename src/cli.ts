#!/usr/bin/env bun

import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import { $ } from "bun";
import { ZodError } from "zod";

import { buildSiteFromData } from "../site/build-data.ts";
import { buildStaticSite } from "../site/build.ts";
import { publishSite } from "../site/publish.ts";
import { serveSite } from "../site/serve.ts";
import { createRestrictedArchive, verifyRestrictedArchive } from "./archive/bagit.ts";
import { systemSchema } from "./contracts.ts";
import { loadBenchmark } from "./core/load.ts";
import { createPlan } from "./core/plan.ts";
import {
  acquireRunCoordinatorLock,
  readRunSummary,
  requireRunDirectory,
  runPlan,
} from "./core/run.ts";
import { requireSupportedToolchain } from "./core/toolchain.ts";
import { loadExercisePackage, materializeExercisePackage } from "./data/exercise-package.ts";
import {
  MEASURED_NOTHING_MESSAGE,
  type ProcessEvaluationSummary,
  runProcessEvaluation,
  withRunEvaluationSource,
} from "./evaluation/process-run.ts";
import { evaluateCandidates } from "./evaluation/runner.ts";
import {
  builtInBundleEvaluatorIdentity,
  builtInDevelopmentSuite,
  executeBundleIntegrityEvaluation,
  loadEvaluationJournalForRelease,
  loadRunEvaluationSource,
  warnIfUnattested,
} from "./evaluation/source.ts";
import {
  discoverTools,
  planTier1,
  planTool,
  releaseArguments,
  runToolPlan,
  type ToolPlan,
} from "./evaluation/tools.ts";
import { readMetricCards } from "./export/metric-card.ts";
import { releaseMetadataFileSchema } from "./export/release-metadata.ts";
import { exportRelease, type ReleaseExportOptions } from "./export/release.ts";
import { verifyRelease } from "./export/verify.ts";
import { EXGEN_VERSION } from "./version.ts";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Print a command's result: the value as JSON with --json, otherwise the human-readable text. */
function report(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function summaryText(summary: ReturnType<typeof readRunSummary>): string {
  const counts = Object.entries(summary.counts)
    .map(([state, count]) => `${state}=${count}`)
    .join(" ");
  return `${summary.runId}: ${counts || "no attempts"} (${summary.total} total)\n${summary.directory}\n`;
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

function repeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function configOverride(value: string, previous = new Map<string, string>()): Map<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new InvalidArgumentError("expected <entry>=<config-path>");
  }
  const id = value.slice(0, separator);
  if (previous.has(id)) {
    throw new InvalidArgumentError(`--config names ${id} twice`);
  }
  return new Map(previous).set(id, value.slice(separator + 1));
}

/** The journal is already written, so an evaluation that measured nothing stays resumable. */
function failIfMeasuredNothing(summary: ProcessEvaluationSummary, label = ""): void {
  if (summary.measured_nothing) {
    process.stderr.write(`error: ${label}${MEASURED_NOTHING_MESSAGE}\n`);
    process.exitCode = 1;
  }
}

function formatProcessSummary(summary: ProcessEvaluationSummary): string {
  return `${summary.executed} evaluated, ${summary.resumed} resumed · ${summary.evaluator_strict_successes} evaluator acceptances · ${summary.quality_failures} quality failures · ${summary.infrastructure_failures} infrastructure failures\n${summary.journal}\n`;
}

async function runTools(
  plan: ToolPlan,
  runDirectory: string,
  options: { retryInfrastructure: boolean; json: boolean },
): Promise<void> {
  for (const id of plan.skipped) {
    process.stderr.write(`skipped ${id}: a template evaluator needs --config; see exgen tools\n`);
  }
  const evaluations = await runToolPlan(plan, {
    runDirectory,
    retryInfrastructure: options.retryInfrastructure,
    // With --json, stdout carries only the final document, so progress goes to stderr.
    onEvaluated: (summary) =>
      (options.json ? process.stderr : process.stdout).write(
        `${summary.tool}/${summary.evaluator.id}: ${formatProcessSummary(summary)}`,
      ),
  });
  const release = releaseArguments(plan.metricCards, evaluations);
  report(
    options.json,
    {
      tools: plan.tools,
      skipped: plan.skipped,
      evaluations,
      release_arguments: release,
    },
    `\nRelease arguments:\n  ${release.map((argument) => $.escape(argument)).join(" ")}\n`,
  );
  for (const evaluation of evaluations) {
    failIfMeasuredNothing(evaluation, `${evaluation.tool}/${evaluation.evaluator.id}: `);
  }
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

function containsModelContent(value: string): boolean {
  if (value === "model-content") return true;
  if (value === "metadata-only") return false;
  throw new InvalidArgumentError("expected metadata-only or model-content");
}

const program = new Command()
  .name("exgen")
  .description("Run and evaluate systems that generate complete programming exercises.")
  .version(EXGEN_VERSION)
  .showSuggestionAfterError()
  .showHelpAfterError();

program.hook("preAction", () => requireSupportedToolchain());

/**
 * The stored projection leaves deviations unread so a legacy run stays loadable; publishing them is
 * a claim, so they are checked against the contract at the release boundary.
 */
function publishableSystems(
  systems: Awaited<ReturnType<typeof loadRunEvaluationSource>>["systems"],
): ReleaseExportOptions["systems"] {
  return systems.map(({ attestation, ...system }) => ({
    ...system,
    attestation:
      attestation === undefined ? undefined : systemSchema.shape.attestation.parse(attestation),
  }));
}

program
  .command("validate")
  .description("Validate a benchmark, dataset, and all referenced exercise briefs.")
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
  .description("Show the complete randomized benchmark plan without running it.")
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
        `${plan.cases.length} cases × ${plan.systems.length} systems × ${plan.trials.replicates} repetitions = ${plan.attempts.length} attempts`,
        "No model or generator was called.",
      ].join("\n")}\n`,
    );
  });

const exercisePackageCommands = program
  .command("exercise-package")
  .description("Validate and materialize external programming-exercise packages.");

exercisePackageCommands
  .command("validate")
  .description("Validate an exercise package and every referenced brief, source, and bundle.")
  .argument("<package>", "exercise package manifest (YAML or JSON)")
  .option("--json", "emit machine-readable output", false)
  .action(async (packagePath, options) => {
    const loaded = await loadExercisePackage(packagePath);
    const result = {
      valid: true,
      package: `${loaded.manifest.id}@${loaded.manifest.version}`,
      status: loaded.manifest.status,
      cases: loaded.cases.length,
      families: new Set(loaded.cases.map((item) => item.familyId)).size,
      digest: loaded.digest,
    };
    report(
      options.json,
      result,
      `Valid ${result.status}: ${result.package} · ${result.cases} cases · ${result.families} families\n${result.digest}\n`,
    );
  });

exercisePackageCommands
  .command("materialize")
  .description("Materialize a ready package as a dataset and metric-neutral reference set.")
  .argument("<package>", "exercise package manifest (YAML or JSON)")
  .requiredOption("--output <directory>", "new materialization output directory")
  .option("--case <ids...>", "materialize only the listed case IDs")
  .option(
    "--allow-wip",
    "materialize a work-in-progress package for exploratory development runs only; every selected case must still carry a complete reference bundle, the dataset records exercise_package_status: wip, and results from it cannot be released as anything other than exploratory",
    false,
  )
  .option("--json", "emit machine-readable output", false)
  .action(async (packagePath, options) => {
    const loaded = await loadExercisePackage(packagePath);
    const result = await materializeExercisePackage(loaded, options.output, {
      ...(options.case === undefined ? {} : { caseIds: options.case }),
      allowWip: options.allowWip,
    });
    report(
      options.json,
      result,
      `${result.cases} cases materialized${
        result.status === "ready"
          ? ""
          : ` from a ${result.status} package: exploratory development runs only`
      }\n${result.datasetPath}\n${result.referenceSetPath}\n`,
    );
  });

program
  .command("run")
  .description("Start a new benchmark run.")
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
    report(options.json, summary, summaryText(summary));
    setOperationalExitCode(summary);
  });

program
  .command("resume")
  .description("Continue attempts that have not started in an existing run.")
  .argument("<run-directory>", "existing run directory")
  .requiredOption("-b, --benchmark <path>", "the same benchmark YAML or JSON")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const loaded = await loadBenchmark(options.benchmark);
    const plan = await createPlan(loaded);
    const runDirectory = await requireRunDirectory(runDirectoryInput);
    const runId = basename(runDirectory);
    const summary = await runPlan(loaded, plan, runId, runDirectory, { create: false });
    report(options.json, summary, summaryText(summary));
    setOperationalExitCode(summary);
  });

program
  .command("status")
  .description("Show the progress of an existing run.")
  .argument("<run-directory>", "existing run directory")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
    const summary = readRunSummary(runDirectory);
    report(options.json, summary, summaryText(summary));
  });

program
  .command("verify")
  .description("Check stored attempts, evidence files, and candidate hashes for consistency.")
  .argument("<run-directory>", "existing run directory")
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
    const source = await loadRunEvaluationSource(runDirectory);
    warnIfUnattested(source);
    const result = {
      valid: true,
      run_id: source.runId,
      plan_id: source.planId,
      attempts: source.generations.length,
      candidates: source.candidates.length,
    };
    report(
      options.json,
      result,
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
    await withRunEvaluationSource(runDirectoryInput, async (source) => {
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
        evaluator_strict_successes: result.responses.filter(
          (response) => response.strict_success === true,
        ).length,
        journal: journalPath,
        warning:
          "development-smoke verifies bundle integrity only; it is not an independent study evaluator",
      };
      report(
        options.json,
        output,
        `${output.executed} evaluated, ${output.resumed} resumed · ${output.evaluator_strict_successes}/${output.candidates} evaluator-accepted bundles\n${output.journal}\n${output.warning}\n`,
      );
    });
  });

evaluationCommands
  .command("process")
  .description("Evaluate candidates with a versioned out-of-process evaluator.")
  .argument("<run-directory>", "existing generated run directory")
  .requiredOption("--config <path>", "process evaluator YAML or JSON")
  .option("--journal <path>", "evaluation journal path")
  .option("--retry-infrastructure", "retry only prior evaluator infrastructure failures", false)
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectoryInput, options) => {
    const output = await runProcessEvaluation({
      runDirectory: runDirectoryInput,
      configPath: options.config,
      ...(options.journal === undefined ? {} : { journalPath: options.journal }),
      retryInfrastructure: options.retryInfrastructure,
    });
    report(options.json, output, formatProcessSummary(output));
    failIfMeasuredNothing(output);
  });

evaluationCommands
  .command("tool")
  .description("Run one evaluation tool over a run; see exgen tools.")
  .argument("<tool>", "tool ID")
  .argument("<run-directory>", "existing generated run directory")
  .addOption(
    new Option(
      "--evaluator <entry>",
      "run this evaluator entry instead of the defaults; repeatable",
    )
      .argParser(repeatable)
      .default([] as string[], "the tool's default evaluators"),
  )
  .option(
    "--config <entry=path>",
    "use another configuration for one evaluator entry of exgen tools; repeatable",
    configOverride,
  )
  .option("--retry-infrastructure", "retry only prior evaluator infrastructure failures", false)
  .option("--json", "emit machine-readable summary", false)
  .action(async (toolId, runDirectory, options) => {
    await runTools(
      await planTool(toolId, options.evaluator, options.config),
      runDirectory,
      options,
    );
  });

evaluationCommands
  .command("tier1")
  .description("Combine Tier 1 evaluation tools over one run; Tier 2 tools are run on their own.")
  .argument("<run-directory>", "existing generated run directory")
  .addOption(
    new Option("--tool <id>", "Tier 1 tool to include; repeatable")
      .argParser(repeatable)
      .default([] as string[], "every Tier 1 tool that needs no --config"),
  )
  .option(
    "--config <entry=path>",
    "use another configuration for one evaluator entry of exgen tools; repeatable",
    configOverride,
  )
  .option("--retry-infrastructure", "retry only prior evaluator infrastructure failures", false)
  .option("--json", "emit machine-readable summary", false)
  .action(async (runDirectory, options) => {
    await runTools(await planTier1(options.tool, options.config), runDirectory, options);
  });

program
  .command("tools")
  .description("List the evaluation tools under tools/ and their evaluators.")
  .option("--json", "emit machine-readable output", false)
  .action(async (options) => {
    const tools = await discoverTools();
    if (options.json) {
      printJson(tools.map((tool) => ({ directory: tool.directory, ...tool.manifest })));
      return;
    }
    for (const tool of tools) {
      process.stdout.write(
        `Tier ${tool.manifest.tier}  ${tool.manifest.id} — ${tool.manifest.title}\n`,
      );
      for (const evaluator of tool.manifest.evaluators) {
        process.stdout.write(
          `  ${evaluator.default ? "*" : " "} ${evaluator.id}${evaluator.template ? " (template: needs --config)" : ""}\n`,
        );
      }
    }
    process.stdout.write("\n* runs by default\n");
  });

const archiveCommands = program
  .command("archive")
  .description("Create and verify restricted, checksummed run archives.");

archiveCommands
  .command("create")
  .description("Copy a complete run into a restricted RFC 8493 BagIt archive.")
  .argument("<run-directory>", "existing generated run directory")
  .requiredOption("--output <directory>", "new archive output directory")
  .requiredOption("--id <identifier>", "stable archive identifier")
  .requiredOption("--retention-until <date>", "retention date in YYYY-MM-DD format")
  .requiredOption(
    "--content <tier>",
    "content tier: metadata-only or model-content; recorded verbatim as the archive's contains_raw_model_content compliance assertion, which nothing cross-checks against the archived telemetry",
    containsModelContent,
  )
  .option("--json", "emit machine-readable output", false)
  .action(async (runDirectoryInput, options) => {
    const runDirectory = await requireRunDirectory(runDirectoryInput);
    const releaseLock = await acquireRunCoordinatorLock(runDirectory);
    try {
      const result = await createRestrictedArchive({
        runDirectory,
        outputDirectory: options.output,
        identifier: options.id,
        retentionUntil: options.retentionUntil,
        containsModelContent: options.content,
      });
      report(
        options.json,
        result,
        `${result.identifier}: ${result.files} files, ${result.bytes} bytes\n${result.directory}\nmanifest sha256 ${result.manifest_sha256}\n`,
      );
    } finally {
      await releaseLock();
    }
  });

archiveCommands
  .command("verify")
  .description("Verify a restricted archive's inventory, digests, and declaration.")
  .argument("<archive-directory>", "existing restricted archive directory")
  .option("--json", "emit machine-readable output", false)
  .action(async (archiveDirectory, options) => {
    const result = await verifyRestrictedArchive(archiveDirectory);
    report(
      options.json,
      result,
      `${result.identifier}: ${result.files} files, ${result.bytes} bytes verified\n${result.directory}\nmanifest sha256 ${result.manifest_sha256}\n`,
    );
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
  .requiredOption(
    "--metric-cards <path>",
    "versioned metric-card JSON; repeat once per evaluation tool",
    repeatable,
  )
  .option(
    "--journal <path>",
    "evaluation journal path; repeat once per evaluator",
    repeatable,
    [] as string[],
  )
  .option(
    "--authoritative-evaluator <id>",
    "evaluator whose strict_success defines the primary estimand; required with several evaluators",
  )
  .option("--json", "emit machine-readable output", false)
  .action(async (runDirectoryInput, options) => {
    await withRunEvaluationSource(runDirectoryInput, async (source) => {
      const journalPaths = (
        options.journal.length > 0
          ? options.journal
          : [join(source.runDirectory, "evaluations", "bundle-integrity.jsonl")]
      ).map((path) => resolve(path));
      const evaluationJournal = await loadEvaluationJournalForRelease(journalPaths);
      const metricCards = await readMetricCards(options.metricCards.map((path) => resolve(path)));
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
          datasetExtensions: source.dataset.extensions,
          target: {
            id: source.target.id,
            version: source.target.version,
            revision: source.target.revision,
          },
        },
        systems: publishableSystems(source.systems),
        cases: source.cases,
        metricCards,
        ...(options.authoritativeEvaluator
          ? { authoritativeEvaluatorId: options.authoritativeEvaluator }
          : {}),
        runManifest: source.runManifest,
        generations: source.generations,
        evaluations: evaluationJournal.latest,
        evaluationHistory: evaluationJournal.history,
        analysis: {
          method: source.runManifest.plan.analysis.method,
          estimand: source.runManifest.plan.analysis.estimand,
          bootstrapSeed: source.runManifest.plan.analysis.bootstrap_seed,
          bootstrapResamples: source.runManifest.plan.analysis.bootstrap_resamples,
          confidenceLevel: source.runManifest.plan.analysis.confidence_level,
          contrasts: source.runManifest.plan.analysis.contrasts,
          ...(source.runManifest.plan.analysis.registration
            ? { registration: source.runManifest.plan.analysis.registration }
            : {}),
        },
      });
      report(
        options.json,
        result,
        `Release ${releaseMetadata.id}@${releaseMetadata.version}\n${result.directory}\nmanifest sha256 ${result.manifestDigest}\n`,
      );
    });
  });

releaseCommands
  .command("verify")
  .description("Verify every file size and SHA-256 digest in a release.")
  .argument("<release-directory>", "release directory")
  .option("--json", "emit machine-readable output", false)
  .action(async (releaseDirectory, options) => {
    const result = await verifyRelease(releaseDirectory);
    report(
      options.json,
      result,
      `${result.releaseId}@${result.version}: ${result.files} files verified\nmanifest sha256 ${result.manifestSha256}\n`,
    );
  });

const siteCommands = program
  .command("site")
  .description("Build or preview the static results site.");

siteCommands
  .command("build")
  .description("Build a self-contained results site from a verified release.")
  .argument("<release-directory>", "verified release directory")
  .requiredOption("--output <directory>", "new static-site output directory")
  .option("--public-url <url>", "canonical URL for a publicly hosted site")
  .option("--json", "emit machine-readable output", false)
  .action(async (releaseDirectory, options) => {
    const result = await publishSite({
      releaseDirectory,
      outputDirectory: options.output,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    });
    report(
      options.json,
      result,
      `Built ${result.releaseId} · ${result.attempts} planned attempts\n${result.directory}\n`,
    );
  });

siteCommands
  .command("build-data")
  .description("Build a static results site from validated public site data.")
  .argument("<data-directory>", "directory containing a release catalog")
  .requiredOption("--output <directory>", "new static-site output directory")
  .option("--public-url <url>", "canonical URL for a publicly hosted site")
  .option("--json", "emit machine-readable output", false)
  .action(async (dataDirectory, options) => {
    const directory = await buildSiteFromData({
      dataDirectory,
      outputDirectory: options.output,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    });
    report(options.json, { directory }, `Built results site\n${directory}\n`);
  });

siteCommands
  .command("serve")
  .description("Preview a static results site locally.")
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
    process.stdout.write(`Results site: ${server.url}\n`);
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
