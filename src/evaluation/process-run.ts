import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { acquireRunCoordinatorLock } from "../core/run.ts";
import {
  evaluationResponseSchema,
  type EvaluationSuite,
  type EvaluatorIdentity,
} from "./contracts.ts";
import { loadProcessEvaluatorConfig, processEvaluationJournalPath } from "./process-config.ts";
import { createEvaluationProcessExecutor } from "./process-executor.ts";
import { evaluateCandidates } from "./runner.ts";
import { loadRunEvaluationSource, warnIfUnattested } from "./source.ts";

export async function requireRunDirectory(input: string): Promise<string> {
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

export interface ProcessEvaluationOptions {
  runDirectory: string;
  configPath: string;
  journalPath?: string;
  retryInfrastructure?: boolean;
}

export interface ProcessEvaluationSummary {
  run_id: string;
  evaluator: EvaluatorIdentity;
  suite: EvaluationSuite;
  candidates: number;
  executed: number;
  resumed: number;
  evaluator_strict_successes: number;
  quality_failures: number;
  infrastructure_failures: number;
  journal: string;
  /** True when every candidate reported an infrastructure failure, so nothing was measured. */
  measured_nothing: boolean;
}

/**
 * One out-of-process evaluator over every candidate of one run, under the run's coordinator lock.
 * `exgen evaluate process` and every evaluation tool under `tools/` go through this, so a tool adds
 * selection and composition but never a second execution path.
 */
export async function runProcessEvaluation(
  options: ProcessEvaluationOptions,
): Promise<ProcessEvaluationSummary> {
  const runDirectory = await requireRunDirectory(options.runDirectory);
  const releaseLock = await acquireRunCoordinatorLock(runDirectory);
  try {
    const source = await loadRunEvaluationSource(runDirectory);
    warnIfUnattested(source);
    const loaded = await loadProcessEvaluatorConfig(options.configPath);
    const config = loaded.config;
    const journalPath = resolve(
      options.journalPath ?? processEvaluationJournalPath(source.runDirectory, loaded),
    );
    const execute = createEvaluationProcessExecutor({
      argv: loaded.argv,
      input: (request) => request,
      responseSchema: evaluationResponseSchema,
      cwd: loaded.cwd,
      env: loaded.environment,
      maximumInputBytes: config.execution.maximum_input_bytes,
      maximumResponseBytes: config.execution.maximum_response_bytes,
      maximumLogBytes: config.execution.maximum_log_bytes,
      terminationGraceMs: config.execution.termination_grace_ms,
      ...(loaded.recovery ? { recovery: loaded.recovery } : {}),
    });
    const result = await evaluateCandidates({
      candidates: source.candidates,
      evaluator: loaded.evaluator,
      suite: config.suite,
      requestedMetrics: config.requested_metrics,
      journalPath,
      concurrency: config.execution.concurrency,
      timeoutMs: config.execution.timeout_ms,
      retryInfrastructureFailures: options.retryInfrastructure ?? false,
      execute,
    });
    const infrastructureFailures = result.responses.filter(
      (response) => response.status === "infra_failed",
    ).length;
    return {
      run_id: source.runId,
      evaluator: loaded.evaluator,
      suite: config.suite,
      candidates: source.candidates.length,
      executed: result.executed,
      resumed: result.resumed,
      evaluator_strict_successes: result.responses.filter(
        (response) => response.strict_success === true,
      ).length,
      quality_failures: result.responses.filter((response) => response.status === "quality_failed")
        .length,
      infrastructure_failures: infrastructureFailures,
      journal: journalPath,
      // An evaluator that reached nothing it could measure reports `infra_failed` for every
      // candidate, and those carry no quality outcome by contract. Reporting success would let a run
      // that measured nothing read as a run that found nothing wrong, which is the opposite claim.
      measured_nothing:
        result.responses.length > 0 && infrastructureFailures === result.responses.length,
    };
  } finally {
    await releaseLock();
  }
}

export const MEASURED_NOTHING_MESSAGE =
  "every candidate reported an infrastructure failure, so this evaluation measured nothing. " +
  "Check that the evaluator configuration points at a backend that can reach the candidates.";
