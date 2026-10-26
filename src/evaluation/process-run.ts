import { resolve } from "node:path";
import { acquireRunCoordinatorLock, requireRunDirectory } from "../core/run.ts";
import {
  evaluationResponseSchema,
  type EvaluationSuite,
  type EvaluatorIdentity,
} from "./contracts.ts";
import {
  type LoadedProcessEvaluatorConfig,
  loadProcessEvaluatorConfig,
  processEvaluationJournalPath,
} from "./process-config.ts";
import { createEvaluationProcessExecutor } from "./process-executor.ts";
import { evaluateCandidates } from "./runner.ts";
import { loadRunEvaluationSource, type RunEvaluationSource, warnIfUnattested } from "./source.ts";

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
 * Hold the run's coordinator lock while `work` reads its candidates, so nothing generates into the
 * run in between. Everything that evaluates or releases a run goes through here.
 */
export async function withRunEvaluationSource<T>(
  runDirectoryInput: string,
  work: (source: RunEvaluationSource) => Promise<T>,
): Promise<T> {
  const runDirectory = await requireRunDirectory(runDirectoryInput);
  const releaseLock = await acquireRunCoordinatorLock(runDirectory);
  try {
    const source = await loadRunEvaluationSource(runDirectory);
    warnIfUnattested(source);
    return await work(source);
  } finally {
    await releaseLock();
  }
}

/** One out-of-process evaluator over every candidate of a run the caller has locked. */
export async function evaluateWithProcess(
  source: RunEvaluationSource,
  loaded: LoadedProcessEvaluatorConfig,
  options: { journalPath?: string | undefined; retryInfrastructure?: boolean | undefined } = {},
): Promise<ProcessEvaluationSummary> {
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
}

/**
 * `exgen evaluate process`: one evaluator over one run under the run's lock. Evaluation tools reuse
 * `evaluateWithProcess`, so they add selection and composition but never a second execution path.
 */
export async function runProcessEvaluation(
  options: ProcessEvaluationOptions,
): Promise<ProcessEvaluationSummary> {
  return withRunEvaluationSource(options.runDirectory, async (source) =>
    evaluateWithProcess(source, await loadProcessEvaluatorConfig(options.configPath), options),
  );
}

export const MEASURED_NOTHING_MESSAGE =
  "every candidate reported an infrastructure failure, so this evaluation measured nothing. " +
  "Check that the evaluator configuration points at a backend that can reach the candidates.";
