import type { EvaluationScore } from "../../../src/evaluation/contracts.ts";
import type { Exercise } from "../shared/exercise.ts";

/**
 * The automatic findings raters see in Part D: what the Tier 1 deterministic evaluators reported
 * about the exercise, restated in plain language and nothing more. Model-assisted, reference-based
 * and judge results are never shown, and no finding is filtered by whether it looks right, because
 * whether the findings are correct is one of the questions raters answer.
 */
export const FINDING_EVALUATORS = [
  "java-oracle",
  "java-static",
  "consistency",
  "promise-traceability",
];

type Finding = Exercise["findings"]["items"][number];

/** One reported problem, before problems of the same kind are grouped into one finding. */
type Draft = Omit<Finding, "id" | "details"> & { detail: string };

/** The part of an evaluation response the findings read. */
interface Evaluation {
  evaluator: { id: string };
  scores: EvaluationScore[];
}

const CONSISTENCY: Record<string, string> = {
  ungrounded_statement_identifier: "The statement names code the exercise does not contain",
  unmentioned_public_api: "The solution declares a type the statement never names",
  contradicted_construct: "The statement and the solution disagree on a required construct",
  unsupported_statement_value: "The statement specifies a value no test checks",
};

/** `UNWITNESSED <kind> — "<sentence>" — <reason>`, as promise-traceability writes a claim. */
const CLAIM = /^UNWITNESSED \S+ — "(.*)" — (.*)$/;

function scoreOf(responses: Evaluation[], metricId: string): EvaluationScore | undefined {
  return responses
    .flatMap((response) => response.scores)
    .find((score) => score.metric_id === metricId);
}

function findingsFrom(responses: Evaluation[]): Draft[] {
  const evidence = (metricId: string) => {
    const score = scoreOf(responses, metricId);
    return score?.status === "ok" ? score.evidence : [];
  };
  const drafts: Draft[] = [];
  for (const line of evidence("consistency.residual_count")) {
    const separator = line.indexOf(":");
    const kind = line.slice(0, separator);
    drafts.push({
      severity: "warning",
      category: "Consistency",
      title: CONSISTENCY[kind] ?? "The statement and the code disagree",
      detail: line.slice(separator + 1).trim(),
    });
  }
  for (const line of evidence("promise.unwitnessed_claims")) {
    const claim = CLAIM.exec(line);
    if (claim !== null) {
      drafts.push({
        severity: "warning",
        category: "Test adequacy",
        title: "No test checks a requirement of the statement",
        detail: `“${claim[1]}”: ${claim[2]}`,
      });
    }
  }
  for (const line of evidence("exception.assertthrows_ratio")) {
    if (line.startsWith("UNWITNESSED ")) {
      drafts.push({
        severity: "warning",
        category: "Test adequacy",
        title: "No test checks an exception the statement names",
        detail: line.slice("UNWITNESSED ".length),
      });
    }
  }
  for (const line of evidence("api.member_reference_ratio")) {
    if (line.startsWith("UNREFERENCED ")) {
      drafts.push({
        severity: "info",
        category: "Test adequacy",
        title: "No test refers to a member the statement declares",
        detail: line.slice("UNREFERENCED ".length),
      });
    }
  }
  for (const line of evidence("boundary.literal_ratio")) {
    if (line.startsWith("ABSENT ")) {
      drafts.push({
        severity: "info",
        category: "Test adequacy",
        title: "No test uses a value the statement states",
        detail: line.slice("ABSENT ".length),
      });
    }
  }
  for (const name of evidence("tests.assertionless_methods")) {
    drafts.push({
      severity: "warning",
      category: "Feedback",
      title: "A test asserts nothing",
      detail: name,
    });
  }
  for (const metric of [
    "concept.required_constructs_present",
    "concept.forbidden_constructs_absent",
  ]) {
    const score = scoreOf(responses, metric);
    if (score?.status === "ok" && score.value === false) {
      drafts.push({
        severity: "warning",
        category: "Concept fidelity",
        title:
          metric === "concept.required_constructs_present"
            ? "The solution does not use a construct the exercise requires"
            : "The solution uses a construct the exercise forbids",
        detail: score.message ?? score.evidence.join("; "),
      });
    }
  }
  const complexity = scoreOf(responses, "complexity.within_bounds");
  if (complexity?.status === "ok" && complexity.value === false) {
    drafts.push({
      severity: "info",
      category: "Complexity",
      title: "The solution's complexity is outside the expected range",
      detail: complexity.message ?? "",
    });
  }
  return drafts;
}

function percent(score: EvaluationScore | undefined): string | null {
  return score?.status === "ok" && typeof score.value === "number"
    ? `${Math.round(score.value * 100)} %`
    : null;
}

/** Findings and the metric summary of one exercise, from its Tier 1 deterministic evaluations. */
export function automaticFindings(
  responses: Evaluation[],
  tests: Exercise["tests"],
): Exercise["findings"] {
  const shown = responses.filter((response) => FINDING_EVALUATORS.includes(response.evaluator.id));
  const all = tests.flatMap((group) => group.tests);
  const bare = all.filter((test) => test.generic);
  const drafts = findingsFrom(shown);
  for (const test of bare) {
    drafts.push({
      severity: bare.length === all.length ? "warning" : "info",
      category: "Feedback",
      title: `${bare.length} of ${all.length} ${all.length === 1 ? "test" : "tests"} ${bare.length === 1 ? "has no failure message of its own" : "have no failure message of their own"}`,
      detail: test.name,
    });
  }
  // Problems of one kind form one finding, so raters judge kinds of problems, not repetitions.
  const grouped = new Map<string, Omit<Finding, "id">>();
  for (const { detail, ...draft } of drafts) {
    const key = `${draft.category}\0${draft.title}`;
    const finding = grouped.get(key) ?? { ...draft, details: [] };
    if (draft.severity === "warning") finding.severity = "warning";
    if (detail !== "") finding.details.push(detail);
    grouped.set(key, finding);
  }
  const gates = scoreOf(shown, "oracle.satisfied");
  const metrics = [
    {
      label: "Build and gates",
      value: gates?.status === "ok" ? (gates.value === true ? "Passed" : "Failed") : null,
    },
    {
      label: "Statement coverage of the solution",
      value: percent(scoreOf(shown, "coverage.statement")),
    },
    { label: "Branch coverage of the solution", value: percent(scoreOf(shown, "coverage.branch")) },
    { label: "Mutation score of the test suite", value: percent(scoreOf(shown, "mutation.score")) },
    {
      label: "Tests per task",
      value: tests.some((group) => group.task !== null)
        ? tests
            .filter((group) => group.task !== null)
            .map((group) => group.tests.length)
            .join(", ")
        : null,
    },
  ].filter((metric): metric is { label: string; value: string } => metric.value !== null);
  return {
    items: [...grouped.values()].map((finding, index) => ({ id: `F${index + 1}`, ...finding })),
    metrics,
  };
}
