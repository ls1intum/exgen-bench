import { describe, expect, test } from "bun:test";
import { summarizeEvaluation } from "../src/evaluation/summary.ts";
import { evaluationResponse, generationObservation } from "./fixtures/evaluation.ts";

const acceptance = (attemptId: string, caseId = "case-1") =>
  evaluationResponse({ candidate: { attempt_id: attemptId, case_id: caseId } });

describe("evaluation summary", () => {
  test("scores a retained candidate from a generation the system did not accept, and never counts it", () => {
    const generations = [generationObservation({ attempt_id: "attempt-1", outcome: "failed" })];

    const summary = summarizeEvaluation(generations, [acceptance("attempt-1")]);

    expect(summary.denominators.candidates).toBe(1);
    expect(summary.denominators.evaluated).toBe(1);
    expect(summary.denominators.evaluator_strict_successes).toBe(1);
    expect(summary.denominators.strict_successes).toBe(0);
    expect(summary.rates.end_to_end_strict_success_over_planned).toBe(0);
  });

  test("still counts an accepted candidate from a succeeded generation", () => {
    const generations = [generationObservation({ attempt_id: "attempt-1" })];

    expect(
      summarizeEvaluation(generations, [acceptance("attempt-1")]).denominators.strict_successes,
    ).toBe(1);
  });

  test("does not count an accepted candidate whose generation exceeded its budget", () => {
    const generations = [
      generationObservation({ attempt_id: "attempt-1", budget_status: "exceeded" }),
    ];

    const summary = summarizeEvaluation(generations, [acceptance("attempt-1")]);

    expect(summary.denominators.evaluator_strict_successes).toBe(1);
    expect(summary.denominators.strict_successes).toBe(0);
  });

  test("counts a non-binding budget as within budget", () => {
    const generations = [
      generationObservation({ attempt_id: "attempt-1", budget_status: "non_binding" }),
    ];

    expect(
      summarizeEvaluation(generations, [acceptance("attempt-1")]).denominators.strict_successes,
    ).toBe(1);
  });

  test("keeps evaluation coverage within one when a failed generation is scored", () => {
    const generations = [
      generationObservation({ attempt_id: "attempt-1", outcome: "failed" }),
      generationObservation({ attempt_id: "attempt-2", case_id: "case-2" }),
    ];
    const evaluations = [acceptance("attempt-1"), acceptance("attempt-2", "case-2")];

    const summary = summarizeEvaluation(generations, evaluations);

    expect(summary.denominators.generated_candidates).toBe(1);
    expect(summary.denominators.candidates).toBe(2);
    expect(summary.rates.evaluation_coverage_over_candidates).toBe(1);
  });

  test("conditions the strict-success rate on the population its numerator is drawn from", () => {
    const generations = [
      generationObservation({ attempt_id: "accepted-success" }),
      generationObservation({ attempt_id: "retained-candidate", outcome: "failed" }),
      generationObservation({ attempt_id: "accepted-rejected" }),
    ];
    const evaluations = [
      acceptance("accepted-success"),
      acceptance("retained-candidate"),
      evaluationResponse({
        status: "quality_failed",
        candidate: { attempt_id: "accepted-rejected" },
      }),
    ];

    const summary = summarizeEvaluation(generations, evaluations);

    expect(summary.denominators.quality_outcomes).toBe(3);
    expect(summary.rates.conditional_strict_success_over_quality_outcomes).toBe(1 / 2);
    expect(summary.rates.conditional_evaluator_acceptance_over_quality_outcomes).toBe(2 / 3);
  });

  test("counts an accepted generation that was never evaluated as missing", () => {
    const generations = [
      generationObservation({ attempt_id: "retained-candidate", outcome: "failed" }),
      generationObservation({ attempt_id: "unevaluated", case_id: "case-2" }),
    ];

    const summary = summarizeEvaluation(generations, [acceptance("retained-candidate")]);

    expect(summary.missingness.generated_not_evaluated).toBe(1);
  });

  test("rejects an evaluation of an attempt that produced no candidate", () => {
    const generations = [
      generationObservation({
        attempt_id: "attempt-1",
        outcome: "failed",
        artifact_digest: null,
      }),
    ];

    expect(() => summarizeEvaluation(generations, [acceptance("attempt-1")])).toThrow(
      "evaluation references attempt without a candidate",
    );
  });
});
