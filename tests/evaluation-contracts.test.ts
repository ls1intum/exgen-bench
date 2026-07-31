import { describe, expect, test } from "bun:test";
import { evaluationResponseSchema, evaluationScoreSchema } from "../src/evaluation/contracts.ts";

describe("evaluation protocol contracts", () => {
  test("requires strict success to agree with the terminal status", () => {
    const base = {
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
      },
      evaluator: {
        id: "test-evaluator",
        version: "1.0.0",
        revision: "revision",
        target_profile: "generic",
        implementation_digest: "d".repeat(64),
      },
      suite: { id: "suite", version: "1.0.0", digest: "e".repeat(64) },
      scores: [],
      started_at: "2026-07-30T00:00:00.000Z",
      finished_at: "2026-07-30T00:00:01.000Z",
      duration_ms: 1000,
    };
    expect(
      evaluationResponseSchema.safeParse({
        ...base,
        status: "succeeded",
        strict_success: false,
      }).success,
    ).toBeFalse();
    expect(
      evaluationResponseSchema.safeParse({
        ...base,
        status: "infra_failed",
        strict_success: null,
        failure_category: "infrastructure.unavailable",
      }).success,
    ).toBeTrue();
  });

  test("does not permit an available score without a value", () => {
    expect(
      evaluationScoreSchema.safeParse({
        metric_id: "tests.pass_rate",
        metric_version: "1",
        status: "ok",
        evidence: [],
      }).success,
    ).toBeFalse();
    expect(
      evaluationScoreSchema.safeParse({
        metric_id: "tests.pass_rate",
        metric_version: "1",
        status: "not_applicable",
        evidence: [],
      }).success,
    ).toBeTrue();
  });
});
