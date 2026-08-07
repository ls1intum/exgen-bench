#!/usr/bin/env bun

// Scores a run exactly as `evaluate process` does, minus the evidence verification a committed run
// cannot pass; `-unverified` on the evaluator revision records that. Expires with exgen-bench#17.

import { acquireRunCoordinatorLock } from "../src/core/run.ts";
import { evaluationResponseSchema } from "../src/evaluation/contracts.ts";
import {
  loadProcessEvaluatorConfig,
  processEvaluationJournalPath,
} from "../src/evaluation/process-config.ts";
import { createEvaluationProcessExecutor } from "../src/evaluation/process-executor.ts";
import { evaluateCandidates } from "../src/evaluation/runner.ts";
import { loadRunEvaluationSource, warnIfUnattested } from "../src/evaluation/source.ts";

const [runPath, configPath] = process.argv.slice(2);
if (runPath === undefined || configPath === undefined) {
  process.stderr.write("usage: bun run scripts/score-run.ts <run-dir> <evaluator-config>\n");
  process.exit(2);
}

const source = await loadRunEvaluationSource(runPath, { verifyEvidence: false });
warnIfUnattested(source);
const loaded = await loadProcessEvaluatorConfig(configPath);
const { config } = loaded;
// The revision is inside the evaluator identity, so the suffix changes the evaluation id and the
// journal's own name, keeping this evidence out of a verified journal.
const evaluator = { ...loaded.evaluator, revision: `${loaded.evaluator.revision}-unverified` };
const journalPath = processEvaluationJournalPath(source.runDirectory, { ...loaded, evaluator });

const releaseLock = await acquireRunCoordinatorLock(source.runDirectory);
try {
  const result = await evaluateCandidates({
    candidates: source.candidates,
    evaluator,
    suite: config.suite,
    requestedMetrics: config.requested_metrics,
    journalPath,
    concurrency: config.execution.concurrency,
    timeoutMs: config.execution.timeout_ms,
    execute: createEvaluationProcessExecutor({
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
    }),
  });
  process.stdout.write(`${result.executed} evaluated, ${result.resumed} resumed\n${journalPath}\n`);
} finally {
  await releaseLock();
}
