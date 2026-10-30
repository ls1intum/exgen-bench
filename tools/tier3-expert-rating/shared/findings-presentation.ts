import type { Exercise, Finding } from "./exercise.ts";

/** Version of the report a rater sees, independent of instrument and frozen evidence. */
export const FINDINGS_PRESENTATION_VERSION = "categories-v1";

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
