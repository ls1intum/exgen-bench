import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { type BundleFile, readCandidateBundle } from "../tools/kit/bundle.ts";
import {
  FLAWS_METRIC_VERSION,
  FLAWS_METRICS,
  flawsOutcome,
} from "../tools/tier1-deterministic/item-writing-flaws/evaluate.ts";
import { findFlaws } from "../tools/tier1-deterministic/item-writing-flaws/flaws.ts";

function file(path: string, content: string): BundleFile {
  return { path, content, bytes: content.length };
}

function testFile(body: string): BundleFile {
  return file(
    "test/de/example/StatsTest.java",
    `package de.example;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
class StatsTest {
${body}
}`,
  );
}

function flaws(statement: string, tests: string, template: BundleFile[] = []) {
  return findFlaws({ statement, template, tests: [testFile(tests)] });
}

describe("assertions without a message", () => {
  test("counts assertions without a message and not those with one", () => {
    const report = flaws(
      "",
      `  @Test void average() {
    assertEquals(2000.5, Stats.average(new int[] {1000, 3001}), 1e-9);
    assertEquals(3, Stats.count(), "count of three days");
    assertTrue(Stats.ok(), () -> "ok after reset");
    assertNotNull(Stats.label());
    assertThrows(IllegalArgumentException.class, () -> Stats.average(null));
    assertThrows(IllegalArgumentException.class, () -> Stats.average(null), "null input");
  }`,
    );
    expect(report.assertions).toBe(6);
    expect(report.assertionsWithoutMessage.map((finding) => finding.detail)).toEqual([
      "assertEquals without a message",
      "assertNotNull without a message",
      "assertThrows without a message",
    ]);
  });

  test("ignores assertions in structural tests and unknown helpers", () => {
    const structural = file(
      "test/de/example/ClassTest.java",
      `package de.example;
class ClassTest extends ClassTestProvider {
  @Test void shape() { assertNotNull(Stats.class); }
}`,
    );
    const report = findFlaws({
      statement: "",
      template: [],
      tests: [structural, testFile("  @Test void t() { assertThat(Stats.count()).isEqualTo(3); }")],
    });
    expect(report.assertions).toBe(0);
  });
});

describe("exact floating-point assertions", () => {
  test("reports a float literal without a delta, with or without a message", () => {
    const report = flaws(
      "",
      `  @Test void average() {
    assertEquals(2000.0, Stats.average(new int[] {1000, 3000}));
    assertEquals(2.5f, Stats.mean(), "mean of two");
    assertEquals(2000.0, Stats.average(new int[] {1000, 3000}), 1e-9);
    assertEquals(3, Stats.count());
  }`,
    );
    expect(report.exactFloatAssertions.map((finding) => finding.detail)).toEqual([
      "assertEquals(2000.0, Stats.average(new int[] {1000, 3000})) compares floating-point values without a delta",
      "assertEquals(2.5f, Stats.mean()) compares floating-point values without a delta",
    ]);
  });
});

describe("tests that only replay a worked example", () => {
  const statement =
    "For example, `findCodes(10, 1000, 1010)` returns `{1009}`.\n\n```java\nsum(4, 5) // 9\n```";

  test("reports a test whose literal calls all come from the statement", () => {
    const report = flaws(
      statement,
      `  @Test void example() { assertEquals(Set.of(1009), Finder.findCodes(10, 1000, 1010)); }
  @Test void other() { assertEquals(Set.of(19), Finder.findCodes(10, 10, 20)); }
  @Test void mixed() { assertEquals(9, Calc.sum(4,5)); assertEquals(1, Calc.sum(0, 1)); }`,
    );
    expect(report.replayedExamples.map((finding) => finding.file)).toEqual([
      "test/de/example/StatsTest.java#example",
    ]);
  });

  test("does not read method declarations in the statement as examples", () => {
    const report = flaws(
      "Implement `int sum(int a, int b)`.",
      "  @Test void t() { assertEquals(9, Calc.sum(4, 5)); }",
    );
    expect(report.replayedExamples).toEqual([]);
  });
});

describe("undefined labels", () => {
  const template = file(
    "src/de/example/Stats.java",
    `package de.example;
public class Stats {
  // TODO S1: compute the average
  // TODO S2: count the days
  public static double average(int[] steps) { return -1; }
}`,
  );

  test("reports template TODO labels and test-message labels the statement never mentions", () => {
    const report = flaws(
      "## S1: Average\nCompute the average.",
      '  @Test void t() { assertTrue(Stats.ok(), "R7: the address needs an @"); }',
      [template],
    );
    expect(report.undefinedLabels.map((finding) => finding.detail)).toEqual([
      "the label R7 is used but the statement never defines it",
      "the label S2 is used but the statement never defines it",
    ]);
  });
});

describe("item-writing-flaws evaluator", () => {
  test("reports every metric at version 1 with no gate", async () => {
    const bundle = await readCandidateBundle(resolve("tools/kit/fixtures/correct-exercise/bundle"));
    const outcome = flawsOutcome(
      findFlaws({ statement: bundle.statement, template: bundle.template, tests: bundle.tests }),
    );
    expect(outcome.gate).toBeNull();
    expect(outcome.scores.map((score) => score.metric_id)).toEqual([...FLAWS_METRICS]);
    expect(new Set(outcome.scores.map((score) => score.metric_version))).toEqual(
      new Set([FLAWS_METRIC_VERSION]),
    );
    expect(outcome.scores.every((score) => score.status === "ok")).toBe(true);
  });

  test("omits the denominator when there is no assertion", () => {
    const outcome = flawsOutcome(findFlaws({ statement: "", template: [], tests: [] }));
    const score = outcome.scores.find(
      (entry) => entry.metric_id === "tests.assertions_without_message",
    );
    expect(score).toMatchObject({ value: 0 });
    expect(score).not.toHaveProperty("denominator");
  });
});
