import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EvaluationCandidate,
  EvaluationRequest,
  EvaluationResponse,
  EvaluationSuite,
  EvaluatorIdentity,
} from "../src/evaluation/contracts.ts";
import {
  EvaluationRecoveryPendingError,
  evaluateCandidates,
  evaluationId,
  readEvaluationJournal,
  readEvaluationJournalHistory,
} from "../src/evaluation/runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const candidate: EvaluationCandidate = {
  experiment_id: "experiment",
  attempt_id: "attempt-1",
  generation_key: "a".repeat(64),
  case_id: "case-1",
  system_id: "system-a",
  replicate: 1,
  artifact_digest: "b".repeat(64),
  bundle_path: "/tmp/candidate",
};
const evaluator: EvaluatorIdentity = {
  id: "test-evaluator",
  version: "1.0.0",
  revision: "revision",
  target_profile: "generic",
  implementation_digest: "c".repeat(64),
};
const suite: EvaluationSuite = {
  id: "test-suite",
  version: "1.0.0",
  digest: "d".repeat(64),
};

function success(request: EvaluationRequest): EvaluationResponse {
  const { bundle_path: _, ...candidateIdentity } = request.candidate;
  return {
    protocol_version: "1",
    evaluation_id: request.evaluation_id,
    candidate: candidateIdentity,
    evaluator: request.evaluator,
    suite: request.suite,
    status: "succeeded",
    strict_success: true,
    scores: [
      {
        metric_id: "tests.pass_rate",
        metric_version: "1",
        status: "ok",
        value: 1,
        numerator: 10,
        denominator: 10,
        evidence: ["test-report.json"],
      },
    ],
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    duration_ms: 1000,
  };
}

describe("resumable evaluation runner", () => {
  test("makes the wall-time budget part of evaluation identity", () => {
    expect(evaluationId(candidate, evaluator, suite, ["tests.pass_rate"], 1_000)).not.toBe(
      evaluationId(candidate, evaluator, suite, ["tests.pass_rate"], 2_000),
    );
  });

  test("reuses an exact evaluation identity without executing it twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluation-"));
    temporaryDirectories.push(directory);
    const journalPath = join(directory, "evaluations.jsonl");
    let calls = 0;
    const execute = async (request: EvaluationRequest): Promise<EvaluationResponse> => {
      calls += 1;
      return success(request);
    };
    const options = {
      candidates: [candidate],
      evaluator,
      suite,
      requestedMetrics: ["tests.pass_rate"],
      journalPath,
      execute,
    };

    expect(await evaluateCandidates(options)).toMatchObject({ executed: 1, resumed: 0 });
    expect(await evaluateCandidates(options)).toMatchObject({ executed: 0, resumed: 1 });
    expect(calls).toBe(1);
    expect((await readEvaluationJournal(journalPath)).size).toBe(1);
  });

  test("discards a crash-truncated final record before resuming", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluation-"));
    temporaryDirectories.push(directory);
    const journalPath = join(directory, "evaluations.jsonl");
    await appendFile(journalPath, '{"protocol_version":"1","evaluation_id":');

    const result = await evaluateCandidates({
      candidates: [candidate],
      evaluator,
      suite,
      requestedMetrics: ["tests.pass_rate"],
      journalPath,
      execute: async (request) => success(request),
    });

    expect(result).toMatchObject({ executed: 1, resumed: 0 });
    expect(await readEvaluationJournalHistory(journalPath)).toHaveLength(1);
  });

  test("records executor exceptions as missing quality outcomes and can retry them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluation-"));
    temporaryDirectories.push(directory);
    const journalPath = join(directory, "evaluations.jsonl");
    let calls = 0;
    const execute = async (request: EvaluationRequest): Promise<EvaluationResponse> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("worker unavailable");
      }
      return success(request);
    };

    const first = await evaluateCandidates({
      candidates: [candidate],
      evaluator,
      suite,
      requestedMetrics: [],
      journalPath,
      execute,
      now: () => "2026-07-30T00:00:00.000Z",
    });
    expect(first.responses[0]?.strict_success).toBeNull();
    expect(first.responses[0]?.status).toBe("infra_failed");

    const second = await evaluateCandidates({
      candidates: [candidate],
      evaluator,
      suite,
      requestedMetrics: [],
      journalPath,
      execute,
      retryInfrastructureFailures: true,
    });
    expect(second.responses[0]?.strict_success).toBeTrue();
    expect(calls).toBe(2);
    expect(await readEvaluationJournalHistory(journalPath)).toHaveLength(2);
  });

  test("does not journal a terminal outcome while remote recovery is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluation-"));
    temporaryDirectories.push(directory);
    const journalPath = join(directory, "evaluations.jsonl");

    await expect(
      evaluateCandidates({
        candidates: [candidate],
        evaluator,
        suite,
        requestedMetrics: [],
        journalPath,
        execute: async () => {
          throw new EvaluationRecoveryPendingError("cleanup unavailable");
        },
      }),
    ).rejects.toBeInstanceOf(EvaluationRecoveryPendingError);
    expect(await readEvaluationJournalHistory(journalPath)).toEqual([]);
  });

  test("keeps the journal open until concurrent evaluations settle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluation-"));
    temporaryDirectories.push(directory);
    const journalPath = join(directory, "evaluations.jsonl");
    const secondCandidate = {
      ...candidate,
      attempt_id: "attempt-2",
      generation_key: "e".repeat(64),
      artifact_digest: "f".repeat(64),
    };

    await expect(
      evaluateCandidates({
        candidates: [candidate, secondCandidate],
        evaluator,
        suite,
        requestedMetrics: ["tests.pass_rate"],
        journalPath,
        concurrency: 2,
        execute: async (request) => {
          if (request.candidate.attempt_id === candidate.attempt_id) {
            throw new EvaluationRecoveryPendingError("cleanup unavailable");
          }
          await Bun.sleep(20);
          return success(request);
        },
      }),
    ).rejects.toBeInstanceOf(EvaluationRecoveryPendingError);

    const history = await readEvaluationJournalHistory(journalPath);
    expect(history).toHaveLength(1);
    expect(history[0]?.candidate.attempt_id).toBe(secondCandidate.attempt_id);
  });

  test("aborts and records a wall-time limit as infrastructure missingness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluation-"));
    temporaryDirectories.push(directory);
    const result = await evaluateCandidates({
      candidates: [candidate],
      evaluator,
      suite,
      requestedMetrics: [],
      journalPath: join(directory, "evaluations.jsonl"),
      timeoutMs: 5,
      execute: async (_request, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
      now: () => "2026-07-30T00:00:00.000Z",
    });
    expect(result.responses[0]).toMatchObject({
      status: "infra_failed",
      strict_success: null,
      failure_category: "evaluator.timeout",
    });
  });
});
