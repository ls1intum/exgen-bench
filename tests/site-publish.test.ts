import { describe, expect, test } from "bun:test";
import {
  classifyPublicOutcome,
  type PublicAttemptClassificationInput,
  type PublicAttemptOutcome,
} from "../site/attempt-outcome.ts";

const successfulAttempt: PublicAttemptClassificationInput = {
  generation_state: "completed",
  generation_outcome: "succeeded",
  evaluation_status: "succeeded",
  evaluator_strict_success: true,
  strict_success: true,
  generation_budget_status: "compliant",
};

describe("public attempt classification", () => {
  test.each(["compliant", "non_binding"] as const)(
    "accepts a successful evaluation with a %s generation budget",
    (generationBudgetStatus) => {
      expect(
        classifyPublicOutcome({
          ...successfulAttempt,
          generation_budget_status: generationBudgetStatus,
        }),
      ).toBe("accepted");
    },
  );

  test("falls back to the release strict-success field", () => {
    expect(classifyPublicOutcome({ ...successfulAttempt, evaluator_strict_success: null })).toBe(
      "accepted",
    );
  });

  test.each([
    [{ generation_state: "planned" }, "not_started"],
    [{ generation_outcome: "abstained" }, "abstained"],
    [{ generation_outcome: "infra_failed" }, "infrastructure_failed"],
    [{ generation_outcome: "failed" }, "generation_failed"],
    [{ generation_budget_status: "exceeded" }, "budget_exceeded"],
    [{ generation_budget_status: "unverifiable" }, "budget_unverifiable"],
    [
      {
        evaluation_status: "quality_failed",
        evaluator_strict_success: false,
        strict_success: false,
      },
      "quality_failed",
    ],
    [
      {
        evaluation_status: null,
        evaluator_strict_success: null,
        strict_success: null,
      },
      "infrastructure_failed",
    ],
  ] satisfies Array<[Partial<PublicAttemptClassificationInput>, PublicAttemptOutcome]>)(
    "classifies %j as %s",
    (overrides, expected) => {
      expect(classifyPublicOutcome({ ...successfulAttempt, ...overrides })).toBe(expected);
    },
  );
});
