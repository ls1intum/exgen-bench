import type { EvaluationScore } from "../../../src/evaluation/contracts.ts";
import type { BundleFile } from "../../kit/bundle.ts";
import type { SubmissionBuild } from "../../tier1-deterministic/java-oracle/backend.ts";
import type { DiffFile, Exercise } from "../shared/exercise.ts";
import type { ConstraintResult } from "./constraints.ts";
import { changedLines, type MutationAnalysis } from "./mutation.ts";

/** Rater-facing checks are a declared subset of Tier 1; no models or Tier 2 scores enter this panel. */
export const FINDING_EVALUATORS = [
  "java-oracle",
  "java-static",
  "consistency",
  "promise-traceability",
  "item-writing-flaws",
];
interface Evaluation {
  evaluator: { id: string };
  scores: EvaluationScore[];
}
type Finding = Exercise["findings"]["items"][number];
export type MutationSummary = Pick<
  MutationAnalysis,
  "ran" | "caught" | "survivors" | "selected" | "discarded" | "unresolved"
>;
export interface FindingMeasurements {
  build: SubmissionBuild;
  solution: BundleFile[];
  diff: DiffFile[];
  constraints: ConstraintResult[];
  unsupportedConstraints?: string[];
}

function scoreOf(responses: Evaluation[], id: string) {
  return responses.flatMap((r) => r.scores).find((s) => s.metric_id === id);
}
export function oracleGatesPassed(responses: Evaluation[]): boolean | undefined {
  const score = scoreOf(
    responses.filter((r) => r.evaluator.id === "java-oracle"),
    "oracle.satisfied",
  );
  return score?.status === "ok" && typeof score.value === "boolean" ? score.value : undefined;
}

/** Fixed presentation policy: evidence-bearing findings, then scoped measurements. No per-exercise curation. */
export function automaticFindings(
  responses: Evaluation[],
  _tests: Exercise["tests"],
  mutation?: MutationSummary,
  measurements?: FindingMeasurements,
): Exercise["findings"] {
  const drafts: Array<Omit<Finding, "id">> = [];
  const shown = responses.filter((r) => FINDING_EVALUATORS.includes(r.evaluator.id));
  const metrics: Exercise["findings"]["metrics"] = [];
  const evidence = (id: string) => {
    const score = scoreOf(shown, id);
    return score?.status === "ok" ? score.evidence : [];
  };
  const changed = measurements ? changedLines(measurements.diff) : null;
  if (measurements) {
    const analysis = measurements.build.analysis;
    if (analysis?.lines) {
      const lines = analysis.lines.filter((line) =>
        measurements.solution.some(
          (file) =>
            (file.path === line.path || file.path.endsWith("/" + line.path)) &&
            changed?.get(file.path)?.has(line.line),
        ),
      );
      const covered = lines.filter((line) => line.covered).length;
      const branches = lines.reduce((n, line) => n + line.branchesCovered + line.branchesMissed, 0);
      const taken = lines.reduce((n, line) => n + line.branchesCovered, 0);
      metrics.push(
        {
          label: "Learner-written lines exercised",
          value: lines.length ? `${covered} of ${lines.length}` : "No executable changes",
        },
        {
          label: "Branch outcomes exercised",
          value: branches ? `${taken} of ${branches}` : "No branches in the changed code",
        },
      );
      const missing = lines.filter((line) => !line.covered || line.branchesMissed > 0);
      if (missing.length)
        drafts.push({
          severity: "info",
          category: "Test coverage",
          title: "Some learner-written code was not exercised",
          details: missing.map(
            (line) =>
              `${line.path}:${line.line} — ${!line.covered ? "line not executed" : `${line.branchesMissed} branch outcome${line.branchesMissed === 1 ? "" : "s"} not executed`}`,
          ),
        });
    } else metrics.push({ label: "Code coverage", value: "Not measured by this build backend" });
    if (analysis?.compiler) {
      const warnings = analysis.compiler.filter((w) => changed?.get(w.path)?.has(w.line));
      if (warnings.length)
        drafts.push({
          severity: warnings.some((w) => w.kind === "unchecked") ? "warning" : "info",
          category: "Type safety",
          title: "The sample solution uses unchecked generic operations",
          details: [
            ...warnings.map((w) => {
              const source = measurements.solution
                .find((f) => f.path === w.path)
                ?.content.split(/\r?\n/)
                [w.line - 1]?.trim();
              return `${w.path}:${w.line} — ${w.kind === "raw_type" ? "raw generic type" : "unchecked operation"}${source ? `: ${source}` : ""}`;
            }),
            ...(analysis.suppressions
              ? ["Warnings checked with suppressions disabled; tests used the original code."]
              : []),
          ],
        });
    } else metrics.push({ label: "Type-safety audit", value: "Not available for this build" });
    for (const result of measurements.constraints.filter((r) => r.outcome === "accepted")) {
      const p = result.probe;
      drafts.push({
        severity: "warning",
        category: "Test adequacy",
        title:
          p.constraint === "stream_api"
            ? "Tests pass without the required stream pipeline"
            : "Tests pass with for instead of the required while loop",
        details: [
          `${p.path}:${p.line} (${p.method}) — ${result.tests} tests passed after ${p.constraint === "stream_api" ? "replacing the stream pipeline with a loop" : "replacing while (condition) with for (; condition;)"}.`,
        ],
      });
    }
    if (measurements.unsupportedConstraints?.length)
      metrics.push({
        label: "Constraint checks not available",
        value: measurements.unsupportedConstraints
          .map((c) =>
            c === "stream_api"
              ? "Stream-pipeline transformation not supported"
              : "While-loop transformation not supported",
          )
          .join("; "),
      });
    const measuredConstraints = measurements.constraints.filter(
      (r) => r.outcome === "accepted" || r.outcome === "rejected",
    );
    if (measuredConstraints.length)
      metrics.push({
        label: "Coding-constraint changes rejected",
        value: `${measuredConstraints.filter((r) => r.outcome === "rejected").length} of ${measuredConstraints.length}`,
      });
    const incomplete = measurements.constraints.filter(
      (r) => r.outcome === "incomplete" || r.outcome === "not_compiled",
    ).length;
    if (incomplete)
      metrics.push({
        label: "Constraint probes not measured",
        value: `${incomplete} could not be evaluated`,
      });
  }
  for (const mutant of mutation?.survivors ?? [])
    drafts.push({
      severity: "warning",
      category: "Test adequacy",
      title: "Tests also pass after these code changes",
      details: [
        mutant.description,
        "A surviving change may be equivalent or outside the stated requirements; inspect the change before judging it a test gap.",
      ],
    });
  const consistencyTitles: Record<string, string> = {
    ungrounded_statement_identifier: "Unknown code reference in the problem statement",
    contradicted_construct: "The sample solution conflicts with a stated coding constraint",
  };
  for (const line of evidence("consistency.residual_count")) {
    const i = line.indexOf(":");
    const kind = line.slice(0, i);
    const title = consistencyTitles[kind];
    if (title)
      drafts.push({
        severity: "warning",
        category: "Consistency",
        title,
        details: [line.slice(i + 1).trim()],
      });
  }
  for (const id of ["concept.required_constructs_present", "concept.forbidden_constructs_absent"]) {
    const score = scoreOf(shown, id);
    if (score?.status === "ok" && score.value === false)
      drafts.push({
        severity: "warning",
        category: "Coding constraint",
        title: id.includes("required")
          ? "A required construct is missing from the sample solution"
          : "The sample solution uses a forbidden construct",
        details: score.evidence.length
          ? score.evidence
          : [score.message ?? "See the construct specification."],
      });
  }
  const floats = evidence("flaws.exact_float_assertions");
  if (floats.length)
    drafts.push({
      severity: "info",
      category: "Test assertions",
      title: "Tests compare floating-point values without a tolerance",
      details: floats,
    });
  if (mutation)
    metrics.push({
      label: "Small code changes rejected",
      value: mutation.ran ? `${mutation.caught} of ${mutation.ran}` : "No completed probes",
    });
  if (mutation?.discarded)
    metrics.push({ label: "Code changes that did not compile", value: String(mutation.discarded) });
  if (mutation?.unresolved)
    metrics.push({
      label: "Code changes without a completed result",
      value: String(mutation.unresolved),
    });
  if (!mutation)
    metrics.push({ label: "Code-change probes", value: "Not measured by this build backend" });
  const grouped = new Map<string, Omit<Finding, "id">>();
  for (const draft of drafts) {
    const key = draft.category + "\0" + draft.title;
    const existing = grouped.get(key);
    if (existing) existing.details = [...new Set([...existing.details, ...draft.details])];
    else grouped.set(key, draft);
  }
  return { items: [...grouped.values()].map((f, i) => ({ id: `F${i + 1}`, ...f })), metrics };
}
