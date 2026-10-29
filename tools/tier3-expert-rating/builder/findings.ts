import type { EvaluationScore } from "../../../src/evaluation/contracts.ts";
import type { Exercise } from "../shared/exercise.ts";
import type { MutationAnalysis } from "./mutation.ts";

/**
 * The automatic findings raters see in Part D: what the Tier 1 deterministic evaluators reported
 * about the exercise, restated in plain language, and what running its tests against wrong variants
 * of the sample solution showed (see `mutation.ts`), and nothing more. Model-assisted, reference-based
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
  ungrounded_statement_identifier: "The problem statement names code the exercise does not contain",
  unmentioned_public_api: "The sample solution declares a type the problem statement never names",
  contradicted_construct:
    "The problem statement and the sample solution disagree on a required construct",
  unsupported_statement_value: "The problem statement specifies a value no test checks",
};

/** Findings of one category stay together, the problem statement's first, then the tests', then the code's. */
const CATEGORY_ORDER = [
  "Consistency",
  "Test adequacy",
  "Test strength",
  "Feedback",
  "Concept fidelity",
  "Complexity",
];

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
      title: CONSISTENCY[kind] ?? "The problem statement and the code disagree",
      detail: line.slice(separator + 1).trim(),
    });
  }
  for (const line of evidence("promise.unwitnessed_claims")) {
    const claim = CLAIM.exec(line);
    if (claim !== null) {
      drafts.push({
        severity: "warning",
        category: "Test adequacy",
        title: "A requirement of the problem statement is not tested",
        detail: `“${claim[1]}”: ${claim[2]}`,
      });
    }
  }
  for (const line of evidence("exception.assertthrows_ratio")) {
    if (line.startsWith("UNWITNESSED ")) {
      drafts.push({
        severity: "warning",
        category: "Test adequacy",
        title: "No test checks an exception the problem statement names",
        detail: line.slice("UNWITNESSED ".length),
      });
    }
  }
  for (const line of evidence("api.member_reference_ratio")) {
    if (line.startsWith("UNREFERENCED ")) {
      drafts.push({
        severity: "info",
        category: "Test adequacy",
        title: "No test refers to a member the problem statement declares",
        detail: line.slice("UNREFERENCED ".length),
      });
    }
  }
  for (const line of evidence("boundary.literal_ratio")) {
    if (line.startsWith("ABSENT ")) {
      drafts.push({
        severity: "info",
        category: "Test adequacy",
        title: "No test uses a value the problem statement gives",
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
            ? "The sample solution does not use a construct the exercise requires"
            : "The sample solution uses a construct the exercise forbids",
        detail: score.message ?? score.evidence.join("; "),
      });
    }
  }
  const complexity = scoreOf(responses, "complexity.within_bounds");
  if (complexity?.status === "ok" && complexity.value === false) {
    drafts.push({
      severity: "info",
      category: "Complexity",
      title: "The sample solution's complexity is outside the expected range",
      detail: complexity.message ?? "",
    });
  }
  return drafts;
}

function numberOf(score: EvaluationScore | undefined): number | null {
  return score?.status === "ok" && typeof score.value === "number" ? score.value : null;
}

/** Tests per task as an instructor reads them: the range over tasks, and tests under no task. */
function testsPerTask(tests: Exercise["tests"]): string | null {
  const counts = tests.filter((group) => group.task !== null).map((group) => group.tests.length);
  if (counts.length === 0) return null;
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const loose = tests.find((group) => group.task === null)?.tests.length ?? 0;
  const range = low === high ? `${low}` : `${low} to ${high}`;
  return loose === 0
    ? range
    : `${range}; ${loose} more ${loose === 1 ? "test belongs" : "tests belong"} to no task`;
}

/**
 * The average alone: Tier 1 counts the tests of behaviour its own way (an Ares structural test is
 * one), so a count of them would disagree with the test overview.
 */
function assertionsPerTest(responses: Evaluation[]): string | null {
  const density = numberOf(scoreOf(responses, "tests.assertion_density"));
  return density === null ? null : `${Number(density.toFixed(1))} on average`;
}

/**
 * Tier 1's highest cyclomatic and cognitive complexity over every method of the solution's files,
 * code the template already has included. The two maxima may come from different methods.
 */
function complexity(responses: Evaluation[]): string | null {
  const cyclomatic = numberOf(scoreOf(responses, "complexity.cyclomatic_max"));
  const cognitive = numberOf(scoreOf(responses, "complexity.cognitive_max"));
  const parts = [
    ...(cyclomatic === null ? [] : [`cyclomatic ${cyclomatic}`]),
    ...(cognitive === null ? [] : [`cognitive ${cognitive}`]),
  ];
  return parts.length === 0 ? null : parts.join(", ");
}

/** What running the tests against wrong variants of the sample solution showed. */
export type MutationSummary = Pick<MutationAnalysis, "ran" | "caught" | "survivors">;

/** Whether the java-oracle gates passed: compiles, solution passes every test, template none. */
export function oracleGatesPassed(responses: Evaluation[]): boolean | undefined {
  const gates = scoreOf(
    responses.filter((response) => response.evaluator.id === "java-oracle"),
    "oracle.satisfied",
  );
  return gates?.status === "ok" && typeof gates.value === "boolean" ? gates.value : undefined;
}

/**
 * Findings and the metric summary of one exercise, from its Tier 1 deterministic evaluations and,
 * when variants ran, from testing wrong variants of the sample solution. Every exercise passed the
 * build and the oracle's gates, so no metric repeats them; the metrics are what tells exercises
 * apart: how strong the tests are, and how complex the sample solution is.
 */
export function automaticFindings(
  responses: Evaluation[],
  tests: Exercise["tests"],
  mutation?: MutationSummary,
): Exercise["findings"] {
  const shown = responses.filter((response) => FINDING_EVALUATORS.includes(response.evaluator.id));
  const all = tests.flatMap((group) => group.tests);
  const bare = all.filter((test) => test.generic);
  const drafts = findingsFrom(shown);
  for (const mutant of mutation?.survivors ?? []) {
    drafts.push({
      severity: "warning",
      category: "Test strength",
      title: "Every test passes on these wrong variants of the sample solution",
      detail: mutant.description,
    });
  }
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
  const metrics = [
    {
      label: "Wrong variants of the sample solution that the tests catch",
      value:
        mutation === undefined || mutation.ran === 0
          ? null
          : `${mutation.caught} of ${mutation.ran}`,
    },
    { label: "Tests per task", value: testsPerTask(tests) },
    { label: "Assertions per test", value: assertionsPerTest(shown) },
    { label: "Highest complexity of a method in the sample solution", value: complexity(shown) },
  ].filter((metric): metric is { label: string; value: string } => metric.value !== null);
  const order = (finding: Omit<Finding, "id">) => {
    const index = CATEGORY_ORDER.indexOf(finding.category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  return {
    items: [...grouped.values()]
      .sort((left, right) => order(left) - order(right))
      .map((finding, index) => ({ id: `F${index + 1}`, ...finding })),
    metrics,
  };
}
