import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { EvaluationRequest, EvaluationResponse } from "../src/evaluation/contracts.ts";
import { evaluateConsistency } from "../evaluators/consistency/evaluate.ts";
import { createOracleEvaluator } from "../evaluators/java-oracle/evaluate.ts";
import { FixtureBuildBackend } from "../evaluators/java-oracle/fixture-backend.ts";
import { createReferenceEvaluator } from "../evaluators/java-reference/evaluate.ts";
import { createStaticEvaluator } from "../evaluators/java-static/evaluate.ts";
import { runEvaluation } from "../evaluators/shared/protocol.ts";

const FIXTURE_ROOT = resolve(import.meta.dir, "../evaluators/fixtures");
const SUITE = join(FIXTURE_ROOT, "suite");
const REFERENCE_SET = join(SUITE, "reference-set.yaml");
const RECORDINGS = join(FIXTURE_ROOT, "oracle-recordings");

/**
 * The machine-readable expectation each fixture carries. This is the acceptance criterion the plan
 * states for WP1: every fixture declares what every evaluator must decide about it, and the corpus
 * runs as a test suite against the evaluators rather than as documentation of them.
 */
const expectedVerdictSchema = z
  .object({
    case_id: z.string().min(1),
    description: z.string().min(1),
    evaluators: z.record(
      z.string(),
      z
        .object({
          status: z.enum(["succeeded", "quality_failed", "infra_failed"]),
          strict_success: z.boolean().nullable(),
          failure_category: z.string().optional(),
          scores: z.record(z.string(), z.union([z.number(), z.boolean(), z.string(), z.null()])),
          not_applicable: z.array(z.string()).default([]),
        })
        .strict(),
    ),
  })
  .strict();

type ExpectedVerdict = z.infer<typeof expectedVerdictSchema>;

const evaluators: Record<string, (request: EvaluationRequest) => Promise<unknown>> = {
  "java-oracle": createOracleEvaluator(new FixtureBuildBackend(RECORDINGS)),
  "java-static": createStaticEvaluator(SUITE),
  "java-reference": createReferenceEvaluator(REFERENCE_SET),
  consistency: evaluateConsistency,
};

function request(caseId: string, evaluatorId: string): EvaluationRequest {
  const suite =
    evaluatorId === "java-reference"
      ? {
          id: "java-reference-development",
          version: "1",
          digest: "2614f63116801063592045f199fb9888992989bea2672146b41668d4af14509e",
        }
      : { id: `${evaluatorId}-fixtures`, version: "1", digest: "d".repeat(64) };
  return {
    protocol_version: "1",
    evaluation_id: `${evaluatorId}-${caseId}`
      .split("")
      .reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 7)
      .toString(16)
      .padStart(64, "0"),
    candidate: {
      experiment_id: "fixture-experiment",
      attempt_id: `${caseId}-attempt`,
      generation_key: "a".repeat(64),
      case_id: caseId,
      system_id: "fixture-system",
      replicate: 1,
      artifact_digest: "b".repeat(64),
      bundle_path: join(FIXTURE_ROOT, caseId, "bundle"),
    },
    evaluator: {
      id: evaluatorId,
      version: "1",
      revision: "source-tree",
      target_profile: "artemis-java-maven",
      implementation_digest: "c".repeat(64),
    },
    suite,
    requested_metrics: [],
  };
}

async function loadExpectations(): Promise<ExpectedVerdict[]> {
  const entries = await readdir(FIXTURE_ROOT, { withFileTypes: true });
  const fixtures = entries
    .filter((entry) => entry.isDirectory() && !["suite", "oracle-recordings"].includes(entry.name))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    fixtures.map(async (name) => {
      const expected = expectedVerdictSchema.parse(
        JSON.parse(await readFile(join(FIXTURE_ROOT, name, "expected.json"), "utf8")),
      );
      expect(expected.case_id).toBe(name);
      return expected;
    }),
  );
}

const expectations = await loadExpectations();

async function evaluate(caseId: string, evaluatorId: string): Promise<EvaluationResponse> {
  const evaluator = evaluators[evaluatorId];
  if (evaluator === undefined) {
    throw new Error(`the fixture corpus expects an unknown evaluator ${evaluatorId}`);
  }
  return runEvaluation(request(caseId, evaluatorId), evaluator as never);
}

describe("fixture candidate corpus", () => {
  test("the reference evaluator rejects a suite identity that does not bind its data", async () => {
    const evaluateReference = createReferenceEvaluator(REFERENCE_SET);
    const mismatched = request("reference-pair", "java-reference");
    mismatched.suite.digest = "0".repeat(64);
    await expect(evaluateReference(mismatched)).rejects.toThrow(
      "evaluation suite does not match reference set",
    );
  });

  test("covers every situation the plan enumerates", () => {
    expect(expectations.map((expected) => expected.case_id)).toEqual([
      "correct-exercise",
      "non-terminating-test",
      "reference-pair",
      "solution-does-not-compile",
      "solution-fails-tests",
      "statement-contradicts-tests",
      "template-already-passes",
      "test-reads-forbidden-file",
    ]);
  });

  for (const expected of expectations) {
    for (const [evaluatorId, verdict] of Object.entries(expected.evaluators)) {
      test(`${expected.case_id} · ${evaluatorId}`, async () => {
        const response = await evaluate(expected.case_id, evaluatorId);
        expect(response.status).toBe(verdict.status);
        expect(response.strict_success).toBe(verdict.strict_success);
        expect(response.failure_category as string | undefined).toBe(verdict.failure_category);
        for (const [metricId, value] of Object.entries(verdict.scores)) {
          const observed = response.scores.find((entry) => entry.metric_id === metricId);
          expect(observed, `${metricId} is missing from the response`).toBeDefined();
          expect(observed?.status, `${metricId} should be an available score`).toBe("ok");
          if (typeof value === "number" && !Number.isInteger(value)) {
            expect(observed?.value as number).toBeCloseTo(value, 6);
          } else {
            expect(observed?.value ?? null).toBe(value);
          }
        }
        for (const metricId of verdict.not_applicable) {
          const observed = response.scores.find((entry) => entry.metric_id === metricId);
          expect(observed?.status, `${metricId} should be not_applicable`).toBe("not_applicable");
          expect(observed?.message).toBeTruthy();
        }
      });
    }
  }

  test("an evaluator is deterministic over the same immutable candidate", async () => {
    for (const evaluatorId of ["java-oracle", "java-static", "java-reference", "consistency"]) {
      const first = await evaluate("correct-exercise", evaluatorId);
      const second = await evaluate("correct-exercise", evaluatorId);
      expect({ ...second, started_at: "", finished_at: "", duration_ms: 0 }).toEqual({
        ...first,
        started_at: "",
        finished_at: "",
        duration_ms: 0,
      });
    }
  });

  test("a build failure is never reported as a quality verdict", async () => {
    const response = await evaluate("non-terminating-test", "java-oracle");
    expect(response.status).toBe("infra_failed");
    expect(response.strict_success).toBeNull();
    // Nothing in an infrastructure failure may look like a measurement.
    expect(response.scores.every((entry) => entry.status === "infra_failure")).toBe(true);
  });

  test("an unreadable bundle is a quality failure, not an infrastructure failure", async () => {
    const broken = request("correct-exercise", "java-oracle");
    const response = await runEvaluation(
      { ...broken, candidate: { ...broken.candidate, bundle_path: "/nonexistent/bundle" } },
      evaluators["java-oracle"] as never,
    );
    expect(response.status).toBe("quality_failed");
    expect(response.failure_category).toBe("candidate.invalid");
  });
});
