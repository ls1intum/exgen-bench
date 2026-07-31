import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  evaluationRequestSchema,
  evaluationResponseSchema,
  type EvaluationRequest,
} from "../src/evaluation/contracts.ts";
import {
  createEvaluationProcessExecutor,
  type EvaluationProcessExecutorOptions,
} from "../src/evaluation/process-executor.ts";
import {
  EvaluationRecoveryPendingError,
  EvaluationTimeoutError,
} from "../src/evaluation/runner.ts";

const temporaryDirectories: string[] = [];
const worker = join(import.meta.dir, "fixtures", "evaluation-process-worker.ts");

const request: EvaluationRequest = evaluationRequestSchema.parse({
  protocol_version: "1",
  evaluation_id: "a".repeat(64),
  candidate: {
    experiment_id: "experiment",
    attempt_id: "attempt",
    generation_key: "b".repeat(64),
    case_id: "case",
    system_id: "system",
    replicate: 1,
    artifact_digest: "c".repeat(64),
    bundle_path: "/candidate",
  },
  evaluator: {
    id: "evaluator",
    version: "1",
    revision: "revision",
    target_profile: "profile",
    implementation_digest: "d".repeat(64),
  },
  suite: {
    id: "suite",
    version: "1",
    digest: "e".repeat(64),
  },
  requested_metrics: ["acceptance"],
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function executor(mode: string, overrides: Partial<EvaluationProcessExecutorOptions> = {}) {
  return createEvaluationProcessExecutor({
    argv: [process.execPath, "run", worker, mode],
    input: (evaluationRequest) => ({ request: evaluationRequest }),
    responseSchema: evaluationResponseSchema,
    ...overrides,
  });
}

describe("out-of-process evaluation executor", () => {
  test("accepts one exact, schema-valid response", async () => {
    const response = await executor("success")(request, {
      signal: new AbortController().signal,
    });
    expect(response.status).toBe("succeeded");
    expect(response.scores[0]?.metric_id).toBe("acceptance");
  });

  test("rejects response extensions", async () => {
    await expect(
      executor("invalid")(request, { signal: new AbortController().signal }),
    ).rejects.toThrow();
  });

  test("terminates and reaps a worker that ignores SIGTERM before reporting timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluation-process-"));
    temporaryDirectories.push(directory);
    const markerPath = join(directory, "pid");
    const recoveryMarkerPath = join(directory, "recovered");
    const timedRequest = { ...request, timeout_ms: 100 };
    const execute = createEvaluationProcessExecutor({
      argv: [process.execPath, "run", worker, "hang", markerPath],
      recovery: {
        argv: [process.execPath, "run", worker, "recover", recoveryMarkerPath],
      },
      input: (evaluationRequest) => ({ request: evaluationRequest }),
      responseSchema: evaluationResponseSchema,
      terminationGraceMs: 25,
    });

    await expect(
      execute(timedRequest, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(EvaluationTimeoutError);
    const pid = Number(await readFile(markerPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readFile(recoveryMarkerPath, "utf8")).toBe(request.evaluation_id);
  });

  test("keeps an evaluation pending when recovery cannot confirm cleanup", async () => {
    const execute = createEvaluationProcessExecutor({
      argv: [process.execPath, "run", worker, "invalid"],
      recovery: {
        argv: [process.execPath, "run", worker, "recovery-fails"],
      },
      input: (evaluationRequest) => ({ request: evaluationRequest }),
      responseSchema: evaluationResponseSchema,
    });

    await expect(execute(request, { signal: new AbortController().signal })).rejects.toBeInstanceOf(
      EvaluationRecoveryPendingError,
    );
  });

  test("bounds response output", async () => {
    await expect(
      executor("oversized", { maximumResponseBytes: 512 })(request, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("response exceeds");
  });
});
