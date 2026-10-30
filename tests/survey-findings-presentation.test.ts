import { describe, expect, test } from "bun:test";

import type { Exercise, Finding } from "../tools/tier3-expert-rating/shared/exercise.ts";
import {
  FINDINGS_PRESENTATION_VERSION,
  findingSections,
  presentFinding,
  unavailableMeasurements,
} from "../tools/tier3-expert-rating/shared/findings-presentation.ts";

const item = (category: string, title: string, id = "F1"): Finding => ({
  id,
  category,
  title,
  severity: "warning",
  details: ["source.java:18 — full unmodified evidence"],
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
