import type { Exercise } from "./exercise.ts";

type Metric = Exercise["findings"]["metrics"][number];

/** Shared wording also explains frozen studies created before descriptions were available. */
const EXPLANATIONS: Array<{
  previous: string;
  label: string;
  description: string;
}> = [
  {
    previous: "Learner-written lines exercised",
    label: "Solution lines reached by tests",
    description:
      "Counts executable lines added or changed from the template. Execution alone does not show that the result was checked.",
  },
  {
    previous: "Branch outcomes exercised",
    label: "Decision outcomes reached by tests",
    description:
      "Counts outcomes of conditions in those lines, such as true and false. It does not count tests or input cases.",
  },
  {
    previous: "Small code changes rejected",
    label: "Modified solutions rejected by tests",
    description:
      "Each selected version changes one operation, such as > to >=. Rejected means at least one test failed. Only selected changes are tested.",
  },
  {
    previous: "Coding-constraint changes rejected",
    label: "Required-construct replacements rejected by tests",
    description:
      "Each version replaces a required construct, such as a while loop. Rejected means at least one test failed.",
  },
  {
    previous: "Code changes that did not compile",
    label: "Modified solutions that did not compile",
    description:
      "Excluded from the total above. A compiler error does not show that the tests caught a problem.",
  },
  {
    previous: "Code changes without a completed result",
    label: "Modified solutions without a completed test result",
    description: "Excluded from the total above; the tests did not produce a completed result.",
  },
];

export function explainFindingMetric(metric: Metric): Metric {
  const wording = EXPLANATIONS.find(
    (entry) => entry.previous === metric.label || entry.label === metric.label,
  );
  return wording
    ? {
        ...metric,
        label: wording.label,
        description: metric.description ?? wording.description,
      }
    : metric;
}
