import { describe, expect, test } from "bun:test";

import type { Exercise, Finding } from "../tools/tier3-expert-rating/shared/exercise.ts";
import {
  FINDINGS_PRESENTATION_VERSION,
  findingSections,
  presentFinding,
  studyFindingsReport,
  unavailableMeasurements,
} from "../tools/tier3-expert-rating/shared/findings-presentation.ts";

const item = (category: string, title: string, id = "F1"): Finding => ({
  id,
  category,
  title,
  severity: "warning",
  details: ["source.java:18 — full unmodified evidence"],
});

describe("main study findings", () => {
  test("keeps targeted grading evidence distinct from counts and generation history", () => {
    const evidence = report(
      [
        item("Verification", "The original draft did not complete generation verification", "F1"),
        item("Verification", "The template already passes some graded tests", "F5"),
        item("Verification", "The exercise does not pass the independent build check", "F6"),
        item("Test adequacy", "Tests pass with for instead of the required while loop", "F2"),
        item("Verification", "The sample solution fails some of its own grading tests", "F3"),
        item("Test coverage", "Some learner-written code was not exercised", "F4"),
      ],
      [
        { label: "Modified solutions rejected by tests", value: "11 of 11" },
        { label: "Learner-written lines exercised", value: "94 of 98" },
        { label: "Type-safety audit", value: "Not available for this build" },
        { label: "Modified solutions without a completed test result", value: "2" },
      ],
    );
    const view = studyFindingsReport(evidence);
    expect(view.sections.map(({ label, findings }) => [label, findings[0]?.id])).toEqual([
      ["Build and test runs", "F3"],
      ["Grading checks", "F2"],
      ["Test coverage", "F4"],
      ["Draft context", "F1"],
    ]);
    expect(view.sections[0]?.findings.map(({ id }) => id)).toEqual(["F3", "F5", "F6"]);
    expect(view.sections[1]?.findings[0]).toMatchObject({
      title: "The tests passed when a while loop was replaced with a for loop",
      tab: "statement",
    });
    expect(view.sections[2]?.findings[0]?.title).toBe(
      "Tests left lines or branch outcomes unexercised",
    );
    expect(view.measurements.map(({ value }) => value)).toEqual(["11 of 11", "94 of 98"]);
    expect(view.limits.map(({ value }) => value)).toEqual(["Not available for this build", "2"]);
    expect(view.coverageNote).toContain("failing tests");
  });

  test("lets reviewers check a flagged string and preserves evidence for other check families", () => {
    const reference = {
      ...item("Consistency", "Unknown code reference in the problem statement"),
      details: ["the statement refers to `Concert`, which appears in no generated artifact"],
    };
    const indirect = item("Feedback", "A test asserts nothing", "F2");
    const unknown = {
      ...item("Grading checks", "New check", "F3"),
      details: ["main: raw evidence"],
    };
    const frozen = report([reference, indirect, unknown]);
    const before = structuredClone(frozen);
    const view = studyFindingsReport(frozen);
    const cards = view.sections.flatMap(({ findings }) => findings);
    expect(cards.find(({ id }) => id === "F1")).toMatchObject({
      evidence: ["Flagged text: Concert"],
      tab: "statement",
    });
    expect(cards.find(({ id }) => id === "F2")?.check).toContain("indirectly");
    expect(cards.find(({ id }) => id === "F3")).toEqual({
      id: "F3",
      title: "New check",
      evidence: unknown.details,
    });
    expect(new Set(view.sections.map(({ id }) => id)).size).toBe(view.sections.length);
    expect(frozen).toEqual(before);
  });

  test("distinguishes an empty report, an unavailable check, and a clean report with measurements", () => {
    const empty = studyFindingsReport(report());
    expect(empty.intro).toMatch(/no automatic findings or usable measurements/);
    expect(empty.limits).toEqual([]);
    const unavailable = studyFindingsReport(
      report([], [{ label: "Coverage", value: "Not measured by this build backend" }]),
    );
    expect(unavailable.intro).toMatch(/no findings or usable measurements/);
    expect(unavailable.limits).toHaveLength(1);
    const measured = studyFindingsReport(
      report([], [{ label: "Modified solutions rejected by tests", value: "11 of 11" }]),
    );
    expect(measured.intro).toMatch(/no findings.*measurements below/);
    expect(measured.measurements).toHaveLength(1);
    expect([empty, unavailable, measured].map(({ intro }) => intro).join(" ")).not.toMatch(
      /passed|ready|success/i,
    );
  });

  test("explains an older probe count without treating raw complexity as a quality measure", () => {
    const view = studyFindingsReport(
      report(
        [],
        [
          { label: "Wrong variants of the sample solution that the tests catch", value: "5 of 5" },
          { label: "Highest complexity of a method in the sample solution", value: "cognitive 2" },
        ],
      ),
    );
    expect(view.measurements).toHaveLength(1);
    expect(view.measurements[0]).toMatchObject({
      label: "Modified solutions rejected by tests",
      value: "5 of 5",
    });
    expect(view.measurements[0]?.description).toContain("Only selected changes are tested.");
  });
});
const report = (
  items: Finding[] = [],
  metrics: Exercise["findings"]["metrics"] = [],
): Exercise["findings"] => ({ items, metrics });

describe("compact automatic findings", () => {
  test("empty categories report absence of findings rather than successful checks", () => {
    const sections = findingSections(report());
    expect(sections.map((s) => s.label)).toEqual(["Consistency", "Solution", "Tests"]);
    expect(sections.every((s) => s.findings.length === 0)).toBe(true);
    expect(JSON.stringify(sections)).not.toMatch(/passed|good|cognitive|difficulty|quality.score/i);
    expect(FINDINGS_PRESENTATION_VERSION).toBe("categories-v1");
  });
  test("categories depend on check families, never exercise or source names", () => {
    const findings = report([
      item("Consistency", "A referenced method was not found", "F1"),
      item("Coding constraint", "A required construct is missing from the sample solution", "F2"),
      item("Type safety", "The sample solution uses unchecked generic operations", "F3"),
      item("Test adequacy", "Tests pass without the required stream pipeline", "F4"),
      item("Test coverage", "Some solution code was not run by the tests", "F5"),
    ]);
    const before = JSON.stringify(findings),
      sections = findingSections(findings);
    expect(sections.map((s) => s.findings.map((f) => f.source.id))).toEqual([
      ["F1", "F2"],
      ["F3"],
      ["F4", "F5"],
    ]);
    expect(JSON.stringify(findings)).toBe(before);
    for (const name of ["CollectionA", "InvoiceLedger", "RenamedType"]) {
      const original = structuredClone(findings);
      original.items.forEach((f) => (f.details = [`${name}.java:34 — different source evidence`]));
      expect(findingSections(original).map((s) => s.findings.map((f) => f.title))).toEqual(
        sections.map((s) => s.findings.map((f) => f.title)),
      );
    }
  });
  test("retains IDs and every original evidence string through summarisation", () => {
    const source = item("Type safety", "The sample solution uses unchecked generic operations");
    source.details = [
      "src/example/A.java:18 — return (List<Item>) raw;",
      "Warnings checked with suppressions disabled; tests used the original code.",
    ];
    const displayed = presentFinding(source);
    expect(displayed.source).toBe(source);
    expect(displayed.source.details).toEqual(source.details);
    expect(displayed.title).toBe("Unchecked generic types");
    expect(displayed.note).toContain("compiler cannot verify");
  });
  test("unknown families and titles stay visible and keep verbatim evidence", () => {
    const unknown = item("A future check", "Unexpected but evidence-bearing observation");
    const familiarCategory = item("Test adequacy", "An unfamiliar check result", "F2");
    const sections = findingSections(report([unknown, familiarCategory]));
    expect(sections[3]).toMatchObject({
      label: "A future check",
      findings: [{ source: unknown, title: unknown.title }],
    });
    expect(sections[2]?.findings[0]).toEqual({
      source: familiarCategory,
      title: familiarCategory.title,
    });
  });
  test("construct observations describe acceptance without claiming global removal or equivalence", () => {
    const stream = presentFinding(
      item("Test adequacy", "Tests pass without the required stream pipeline"),
    );
    expect(stream.title).toBe(
      "Tests still pass when a required stream pipeline is replaced by a loop",
    );
    expect(stream.note).toBe("Each replacement was tested separately.");
    expect(stream.title).not.toMatch(/no test|all requirements|equivalent|entire solution/);
    const loop = presentFinding(
      item("Test adequacy", "Tests pass with for instead of the required while loop"),
    );
    expect(loop.title).toContain("required while loop is replaced by a for loop");
  });
  test("surviving edits and unexecuted demo code stay observations requiring judgement", () => {
    expect(
      presentFinding(item("Test adequacy", "Tests also pass after these code changes")).note,
    ).toContain("valid alternative");
    for (const title of [
      "Some solution code was not run by the tests",
      "Some learner-written code was not exercised",
    ])
      expect(presentFinding(item("Test coverage", title)).note).toContain(
        "outside the graded task",
      );
    expect(
      presentFinding(
        item("Test assertions", "Tests compare floating-point values without a tolerance"),
      ).note,
    ).toContain("appropriate");
  });
  test("does not infer passes or quality bands from numerical or malformed measurements", () => {
    for (const value of ["0 of 0", "11 of 11", "12 of 11", "not a ratio", "100%"]) {
      const findings = report([], [{ label: "Modified solutions rejected by tests", value }]);
      expect(findingSections(findings).every((s) => s.findings.length === 0)).toBe(true);
      expect(findings.metrics[0]?.value).toBe(value);
    }
    expect(
      unavailableMeasurements(
        report([], [{ label: "Code coverage", value: "Not measured by this build backend" }]),
      ),
    ).toBe(true);
    expect(
      unavailableMeasurements(
        report([], [{ label: "Modified solutions without a completed test result", value: "2" }]),
      ),
    ).toBe(true);
    expect(
      unavailableMeasurements(
        report([], [{ label: "Modified solutions without a completed test result", value: "0" }]),
      ),
    ).toBe(false);
  });
});

test("released presentation copy is pinned with its version", () => {
  // After release, changing this wording requires a new presentation ID and snapshot name.
  const catalog = [
    ["Type safety", "The sample solution uses unchecked generic operations"],
    ["Test adequacy", "Tests pass without the required stream pipeline"],
    ["Test adequacy", "Tests pass with for instead of the required while loop"],
    ["Test adequacy", "Tests also pass after these code changes"],
    ["Test coverage", "Some solution code was not run by the tests"],
    ["Test assertions", "Tests compare floating-point values without a tolerance"],
  ].map(([category, title]) => {
    const p = presentFinding(item(category!, title!));
    return { category, title: p.title, note: p.note ?? null };
  });
  expect({
    version: FINDINGS_PRESENTATION_VERSION,
    categories: findingSections(report()).map((s) => s.label),
    catalog,
  }).toMatchSnapshot(FINDINGS_PRESENTATION_VERSION);
});
