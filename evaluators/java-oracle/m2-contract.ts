import type { EvaluationResponse } from "../../src/evaluation/contracts.ts";

/**
 * The metric contract both build backends must satisfy, and the rule for comparing two runs of it.
 *
 * This is M2's acceptance criterion expressed as code rather than as prose, so it can be tested
 * offline against recorded HTTP fixtures and then executed unchanged against a live deployment. What
 * the plan states as "identical verdicts from the live backend on the same fixtures" needs one
 * qualification to be checkable at all, and encoding it here keeps that qualification honest instead
 * of leaving it to whoever reads the output.
 */

/** A property of the exercise. Both backends must agree exactly, value included. */
export const VERDICT_METRICS = [
  "build.template_compiles",
  "build.solution_compiles",
  "tests.executable",
  "tests.count",
  "oracle.solution_pass_rate",
  "oracle.template_pass_rate",
  "oracle.satisfied",
] as const;

/**
 * A property of the deployment, or deferred work. Compared by availability, not by value.
 *
 * `coverage.statement` measures a real build on the live side and replays a hand-authored number on
 * the fixture side, so requiring equality would fail M2 for a reason that says nothing about whether
 * the two backends agree on the exercise.
 */
export const STATUS_ONLY_METRICS = [
  "coverage.statement",
  "coverage.branch",
  "mutation.score",
] as const;

/** Metrics that must be unavailable on *both* sides, each with the reason it is unavailable. */
export const MUST_BE_NOT_APPLICABLE: Record<string, string> = {
  "coverage.branch": "the Artemis coverage endpoint reports line counts only (WP2c fills this)",
  "mutation.score": "mutation testing needs sealed suite assets (WP2c)",
};

export interface Divergence {
  caseId: string;
  detail: string;
}

function score(response: EvaluationResponse, metricId: string) {
  return response.scores.find((entry) => entry.metric_id === metricId);
}

/**
 * Every way the two runs disagree, as a list. Empty means M2 holds for this case.
 *
 * An infrastructure failure on one side only is reported as a divergence rather than skipped: a
 * timeout is not a verdict, so it can never stand in for agreement about one.
 */
export function compareVerdicts(
  caseId: string,
  offline: EvaluationResponse,
  live: EvaluationResponse,
): Divergence[] {
  const divergences: Divergence[] = [];
  const note = (detail: string): void => {
    divergences.push({ caseId, detail });
  };

  // `strict_success` carries the primary estimand: a difference here would invalidate a study, not
  // merely flag a metric-level discrepancy.
  if (offline.status !== live.status) {
    note(`status: fixture=${offline.status} live=${live.status}`);
  }
  if (offline.strict_success !== live.strict_success) {
    note(`strict_success: fixture=${offline.strict_success} live=${live.strict_success}`);
  }
  if (offline.failure_category !== live.failure_category) {
    note(
      `failure_category: fixture=${offline.failure_category ?? "none"} live=${live.failure_category ?? "none"}`,
    );
  }

  // An infrastructure failure carries no scores at all -- that is the protocol's way of refusing to
  // let a timeout look like a measurement. So once both sides agree they failed, the verdict fields
  // above are the entire comparison, and the only thing left to check is that neither side smuggled a
  // measurement out anyway.
  if (offline.status === "infra_failed" && live.status === "infra_failed") {
    for (const [label, response] of [
      ["fixture", offline],
      ["live", live],
    ] as const) {
      const measured = response.scores.filter((entry) => entry.status === "ok");
      if (measured.length > 0) {
        note(
          `${label} reported an infrastructure failure but still scored ${measured.map((entry) => entry.metric_id).join(", ")}`,
        );
      }
    }
    return divergences;
  }

  for (const metricId of VERDICT_METRICS) {
    const offlineScore = score(offline, metricId);
    const liveScore = score(live, metricId);
    if (offlineScore?.status !== liveScore?.status) {
      note(
        `${metricId} status: fixture=${offlineScore?.status ?? "absent"} live=${liveScore?.status ?? "absent"}`,
      );
      continue;
    }
    if (offlineScore?.status === "ok" && offlineScore.value !== liveScore?.value) {
      note(`${metricId}: fixture=${String(offlineScore.value)} live=${String(liveScore?.value)}`);
    }
  }

  for (const metricId of STATUS_ONLY_METRICS) {
    const offlineScore = score(offline, metricId);
    const liveScore = score(live, metricId);
    const required = MUST_BE_NOT_APPLICABLE[metricId];
    if (required !== undefined) {
      for (const [label, observed] of [
        ["fixture", offlineScore],
        ["live", liveScore],
      ] as const) {
        if (observed?.status !== "not_applicable") {
          note(
            `${metricId} must be not_applicable on ${label} (${required}), got ${observed?.status ?? "absent"}`,
          );
        }
      }
      continue;
    }
    if (offlineScore?.status !== liveScore?.status) {
      note(
        `${metricId} availability: fixture=${offlineScore?.status ?? "absent"} live=${liveScore?.status ?? "absent"}`,
      );
    }
  }
  return divergences;
}
