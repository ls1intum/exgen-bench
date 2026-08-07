import { describe, expect, test } from "bun:test";
import {
  evaluationRequestSchema,
  evaluationResponseSchema,
  evaluationScoreSchema,
} from "../src/evaluation/contracts.ts";
import { evaluationResponse } from "./fixtures/evaluation.ts";

describe("evaluation protocol contracts", () => {
  test("requires strict success to agree with the terminal status", () => {
    const { status: _status, strict_success: _strictSuccess, ...base } = evaluationResponse();

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

  test("accepts a protocol-1 request that omits capture completeness", () => {
    const request = {
      protocol_version: "1",
      evaluation_id: "a".repeat(64),
      candidate: {
        experiment_id: "experiment",
        attempt_id: "attempt-1",
        generation_key: "b".repeat(64),
        case_id: "case-1",
        system_id: "system-a",
        replicate: 1,
        artifact_digest: "c".repeat(64),
        bundle_path: "/tmp/candidate",
      },
      evaluator: {
        id: "test-evaluator",
        version: "1.0.0",
        revision: "revision",
        target_profile: "generic",
        implementation_digest: "d".repeat(64),
      },
      suite: { id: "suite", version: "1.0.0", digest: "e".repeat(64) },
      requested_metrics: [],
    };

    expect(evaluationRequestSchema.safeParse(request).success).toBeTrue();
    expect(
      evaluationRequestSchema.safeParse({
        ...request,
        candidate: { ...request.candidate, capture_completeness: "partial" },
      }).success,
    ).toBeTrue();
  });
});
