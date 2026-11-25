import type { Exercise, Finding } from "./exercise.ts";
import { explainFindingMetric } from "./finding-metrics.ts";

/** Version of the report a rater sees, independent of instrument and frozen evidence. */
export const FINDINGS_PRESENTATION_VERSION = "categories-v1";
export const STUDY_FINDINGS_PRESENTATION_VERSION = "evidence-v2";

export interface PresentedFinding {
  source: Finding;
  title: string;
  note?: string;
}
export interface FindingSection {
  id: string;
  label: string;
  findings: PresentedFinding[];
}

const CATEGORIES = [
  { id: "consistency", label: "Consistency", families: ["Consistency", "Coding constraint"] },
  { id: "solution", label: "Solution", families: ["Type safety"] },
  { id: "tests", label: "Tests", families: ["Test adequacy", "Test coverage", "Test assertions"] },
] as const;

/** Short observations for known check families. Never infer a quality or cognitive score. */
export function presentFinding(finding: Finding): PresentedFinding {
  const key = finding.category + ":" + finding.title;
  switch (key) {
    case "Type safety:The sample solution uses unchecked generic operations":
      return {
        source: finding,
        title: "Unchecked generic types",
        note: "The compiler cannot verify some generic types in the solution.",
      };
    case "Test adequacy:Tests pass without the required stream pipeline":
      return {
        source: finding,
        title: "Tests still pass when a required stream pipeline is replaced by a loop",
        note: "Each replacement was tested separately.",
      };
    case "Test adequacy:Tests pass with for instead of the required while loop":
      return {
        source: finding,
        title: "Tests still pass when a required while loop is replaced by a for loop",
      };
    case "Test adequacy:Tests also pass after these code changes":
      return {
        source: finding,
        title: "Tests still pass after selected edits to the solution",
        note: "An accepted edit may be a valid alternative. Inspect the evidence.",
      };
    case "Test coverage:Some learner-written code was not exercised":
    case "Test coverage:Some solution code was not run by the tests":
      return {
        source: finding,
        title: "Some solution code was not executed by the tests",
        note: "Unexecuted code may be outside the graded task.",
      };
    case "Test assertions:Tests compare floating-point values without a tolerance":
      return {
        source: finding,
        title: finding.title,
        note: "Check whether exact equality is appropriate.",
      };
    default:
      return { source: finding, title: finding.title };
  }
}

/** Retain every finding, ID and original evidence, including unfamiliar future check families. */
export function findingSections(findings: Exercise["findings"]): FindingSection[] {
  const sections: FindingSection[] = CATEGORIES.map(({ id, label }) => ({
    id,
    label,
    findings: [],
  }));
  const other = new Map<string, FindingSection>();
  for (const finding of findings.items) {
    const known = CATEGORIES.find((c) =>
      (c.families as readonly string[]).includes(finding.category),
    );
    let section = known ? sections.find((s) => s.id === known.id) : other.get(finding.category);
    if (!section) {
      section = { id: `other-${other.size + 1}`, label: finding.category, findings: [] };
      other.set(finding.category, section);
      sections.push(section);
    }
    section.findings.push(presentFinding(finding));
  }
  return sections;
}

/** Surface explicit missing results without turning absent findings into completed checks. */
export function unavailableMeasurements(findings: Exercise["findings"]): boolean {
  return findings.metrics.some(
    (metric) =>
      /not measured|not available|unavailable|not supported|no completed|could not be evaluated/i.test(
        metric.value,
      ) ||
      (/without a completed (?:test )?result/.test(metric.label) && Number(metric.value) > 0),
  );
}

export type FindingReviewTab = "statement" | "template" | "diff" | "tests";
type ReportMetric = ReturnType<typeof explainFindingMetric>;

interface FindingGuidance {
  title?: string;
  check: string;
  tab: FindingReviewTab;
}

const REFERENCE_CHECK: FindingGuidance = {
  title: "Some names in the problem statement could not be matched",
  check:
    "Check the surrounding text. File names and words in examples or printed output can trigger this check.",
  tab: "statement",
};
const COVERAGE_CHECK: FindingGuidance = {
  title: "Tests left lines or branch outcomes unexercised",
  check: "Check whether the missed code affects a requirement students are asked to implement.",
  tab: "diff",
};
const CONSTRUCT_CHECK = {
  check:
    "Each replacement was tested separately. Check where the problem statement requires this construct.",
  tab: "statement",
} as const;
const LEGACY_TEST_CHECK = {
  check: "Compare the cited requirement or example with what the tests check.",
  tab: "tests",
} as const;

const GUIDANCE: ReadonlyMap<string, FindingGuidance> = new Map([
  [
    "Verification:The original draft did not complete generation verification",
    {
      title: "The draft did not complete generation verification",
      check:
        "This is how the draft was retained. Use the build and test results for specific failures.",
      tab: "tests",
    },
  ],
  [
    "Verification:The exercise does not pass the independent build check",
    {
      title: "The independent build and test check reported failures",
      check:
        "Check the reported outcomes to see whether the starter code, sample solution or tests need attention.",
      tab: "tests",
    },
  ],
  [
    "Verification:The tests did not run against the sample solution",
    {
      check: "The build log may explain what prevented the tests from running.",
      tab: "tests",
    },
  ],
  [
    "Verification:The sample solution does not compile",
    {
      check: "Use the diagnostic to locate the problem in the sample solution.",
      tab: "diff",
    },
  ],
  [
    "Verification:The template already passes some graded tests",
    {
      title: "Some grading tests already pass on the starter code",
      check:
        "Check what each test is meant to assess. Passing on the starter code can be expected for some checks.",
      tab: "tests",
    },
  ],
  [
    "Verification:The sample solution fails some of its own grading tests",
    {
      title: "The sample solution failed grading tests",
      check:
        "Compare the failed behaviour with the task to see whether the solution or the test needs a change.",
      tab: "tests",
    },
  ],
  [
    "Test adequacy:Tests accept a fixed-output replacement",
    {
      title: "The tests passed with fixed printed output",
      check:
        "The probe replaced the program entry point. Check what behaviour the task requires beyond the printed output.",
      tab: "statement",
    },
  ],
  [
    "Test adequacy:Tests also pass after these code changes",
    {
      title: "The tests passed after selected changes to the solution",
      check:
        "Check whether a change breaks a stated requirement. Some changes may still give a correct solution.",
      tab: "statement",
    },
  ],
  [
    "Test adequacy:Tests pass without the required stream pipeline",
    {
      ...CONSTRUCT_CHECK,
      title: "The tests passed when a stream pipeline was replaced with a loop",
    },
  ],
  [
    "Test adequacy:Tests pass with for instead of the required while loop",
    {
      ...CONSTRUCT_CHECK,
      title: "The tests passed when a while loop was replaced with a for loop",
    },
  ],
  ["Test coverage:Some solution code was not run by the tests", COVERAGE_CHECK],
  ["Test coverage:Some learner-written code was not exercised", COVERAGE_CHECK],
  [
    "Type safety:The sample solution uses unchecked generic operations",
    {
      title: "Java reported generic-type warnings in the sample solution",
      check: "Check how the cited values are declared, used or returned.",
      tab: "diff",
    },
  ],
  [
    "Test assertions:Tests compare floating-point values without a tolerance",
    {
      title: "Tests compare floating-point values exactly",
      check:
        "Exact comparison can be appropriate for stored values. Check how the expected result is produced.",
      tab: "tests",
    },
  ],
  ["Consistency:Unknown code reference in the problem statement", REFERENCE_CHECK],
  ["Consistency:The problem statement names code the exercise does not contain", REFERENCE_CHECK],
  [
    "Consistency:The sample solution conflicts with a stated coding constraint",
    {
      title: "The check flagged a possible conflict with a coding requirement",
      check:
        "Compare the stated requirement with the cited code before treating this as a conflict.",
      tab: "statement",
    },
  ],
  [
    "Coding constraint:A required construct is missing from the sample solution",
    {
      title: "The check did not detect a required construct",
      check: "Check the stated requirement and the code that implements it.",
      tab: "diff",
    },
  ],
  [
    "Coding constraint:The sample solution uses a forbidden construct",
    {
      title: "The check flagged a restricted construct",
      check:
        "Check where the restriction applies and whether the cited code uses the construct there.",
      tab: "diff",
    },
  ],
  [
    "Test adequacy:A requirement of the problem statement is not tested",
    {
      ...LEGACY_TEST_CHECK,
      title: "The check flagged a requirement that might lack a test",
    },
  ],
  [
    "Test adequacy:No test refers to a member the problem statement declares",
    {
      ...LEGACY_TEST_CHECK,
      title: "The check found no direct test reference to a declared member",
    },
  ],
  [
    "Test adequacy:No test uses a value the problem statement gives",
    {
      ...LEGACY_TEST_CHECK,
      title: "The check found no direct test reference to an example value",
    },
  ],
  [
    "Feedback:A test asserts nothing",
    {
      title: "The check detected no assertion in a test",
      check: "The result alone cannot show whether the test checks behaviour indirectly.",
      tab: "tests",
    },
  ],
]);

const RETAINED_DRAFT = "The original draft did not complete generation verification";
const BUILD_CONTEXT = new Set([
  "The exercise does not pass the independent build check",
  "The template already passes some graded tests",
]);
const LEGACY_TEST_COUNTS = new Set([
  "Tests per task",
  "Assertions per test",
  "Highest complexity of a method in the sample solution",
]);

const REPORT_GROUPS = [
  { label: "Build and test runs", families: ["Verification"] },
  { label: "Grading checks", families: ["Test adequacy", "Test assertions", "Feedback"] },
  {
    label: "Statement and solution",
    families: ["Consistency", "Coding constraint", "Type safety"],
  },
  { label: "Test coverage", families: ["Test coverage"] },
] as const;

export interface FindingCard {
  id: string;
  title: string;
  check?: string;
  tab?: FindingReviewTab;
  evidence: string[];
}

export const STUDY_MEASUREMENTS_LABEL = "Recorded measurements";
export const STUDY_CHECK_LIMITS_LABEL = "Checks with limited or missing results";
export const STUDY_EVIDENCE_PREVIEW = 3;

function reviewEvidence(detail: string, references: boolean): string {
  if (references) {
    const name = /^the statement refers to `(.+)`, which appears in no generated artifact$/.exec(
      detail,
    );
    if (name !== null) return `Flagged text: ${name[1]}`;
  }
  if (detail.startsWith("main:")) return `Program entry point: ${detail.slice("main:".length)}`;
  if (detail.startsWith("observed_by:"))
    return `Test that checks the output: ${detail.slice("observed_by:".length)}`;
  if (detail.startsWith("transcript_characters:"))
    return `Printed output length: ${detail.slice("transcript_characters:".length)} characters`;
  if (detail.startsWith("solution:"))
    return `Sample solution build: ${detail.slice("solution:".length)}`;
  if (detail.startsWith("template:"))
    return `Starter code build: ${detail.slice("template:".length)}`;
  return detail;
}

function failedMeasurement(metric: ReportMetric): boolean {
  return (
    /^(?:not measured|not available|unavailable|not supported|no completed)\b/i.test(
      metric.value,
    ) ||
    (metric.label === "Constraint checks not available" && /\bunavailable\b/i.test(metric.value)) ||
    (metric.label === "Constraint probes not measured" &&
      /^\d+ could not be evaluated/i.test(metric.value)) ||
    (/without a completed (?:test )?result/i.test(metric.label) && Number(metric.value) > 0) ||
    (metric.label === "Modified solutions that did not compile" && Number(metric.value) > 0)
  );
}

/** The participant-facing findings, shared with the Stage D prompt and citation catalogue. */
export function studyFindingsReport(findings: Exercise["findings"]) {
  const groups: Array<{ id: string; label: string; findings: FindingCard[] }> = REPORT_GROUPS.map(
    ({ label }) => ({ id: label, label, findings: [] }),
  );
  const extra = new Map<string, FindingCard[]>();
  const context: FindingCard[] = [];
  const buildContext: FindingCard[] = [];
  for (const finding of findings.items) {
    const guidance = GUIDANCE.get(`${finding.category}:${finding.title}`);
    const index = REPORT_GROUPS.findIndex(({ families }) =>
      (families as readonly string[]).includes(finding.category),
    );
    const isFixedOutput =
      finding.category === "Test adequacy" &&
      finding.title === "Tests accept a fixed-output replacement";
    const substantive = isFixedOutput
      ? [
          ...finding.details.filter(
            (detail) =>
              !detail.startsWith("transcript_characters:") &&
              detail !==
                "A separate executable probe replaced the entry point with fixed printed output and the graded tests still passed. Check whether the brief requires behavior beyond that output.",
          ),
          ...finding.details.filter((detail) => detail.startsWith("transcript_characters:")),
        ]
      : finding.details;
    const card: FindingCard = {
      id: finding.id,
      title: guidance?.title ?? finding.title,
      ...(guidance === undefined ? {} : { check: guidance.check, tab: guidance.tab }),
      evidence:
        guidance === undefined
          ? [...substantive]
          : substantive.map((detail) => reviewEvidence(detail, guidance === REFERENCE_CHECK)),
    };
    if (finding.category === "Verification" && finding.title === RETAINED_DRAFT) {
      context.push(card);
    } else if (finding.category === "Verification" && BUILD_CONTEXT.has(finding.title)) {
      // Show sample failures before aggregate results or starter-code results already shown in C.
      buildContext.push(card);
    } else if (index >= 0) {
      groups[index]?.findings.push(card);
    } else {
      let group = extra.get(finding.category);
      if (group === undefined) {
        group = [];
        extra.set(finding.category, group);
      }
      group.push(card);
    }
  }
  groups[0]?.findings.push(...buildContext);
  const sections = groups
    .concat([...extra].map(([label, findings]) => ({ id: `raw:${label}`, label, findings })))
    .concat({ id: "Draft context", label: "Draft context", findings: context })
    .filter(({ findings }) => findings.length > 0);
  const measurements: ReportMetric[] = [];
  const limits: ReportMetric[] = [];
  for (const raw of findings.metrics) {
    // Earlier archives include counts that do not support a review decision in this report.
    if (LEGACY_TEST_COUNTS.has(raw.label)) continue;
    const metric = explainFindingMetric(
      raw.label === "Wrong variants of the sample solution that the tests catch"
        ? { ...raw, label: "Small code changes rejected" }
        : raw,
    );
    (failedMeasurement(metric) ? limits : measurements).push(metric);
  }
  const hasMeasuredResult = measurements.some(
    ({ value }) =>
      !/^(?:no executable changes|no branches in the changed code|0 of 0)$/i.test(value),
  );
  const intro =
    sections.length > 0
      ? "These results cover selected parts of the exercise. Check any result you use against the task."
      : hasMeasuredResult
        ? "The checks reported no findings. The measurements below show what they recorded."
        : limits.length > 0
          ? "The checks reported no findings or usable measurements. See the check limits below."
          : "There are no automatic findings or usable measurements for this exercise.";

  const coverageNote =
    findings.items.some(
      ({ category, title }) =>
        category === "Verification" &&
        title === "The sample solution fails some of its own grading tests",
    ) &&
    measurements.some(
      ({ label }) =>
        label === "Solution lines reached by tests" ||
        label === "Decision outcomes reached by tests",
    )
      ? "Coverage can include a run with failing tests. Read it alongside the recorded failures."
      : undefined;

  return { sections, measurements, limits, intro, coverageNote };
}
