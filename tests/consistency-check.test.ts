import { describe, expect, test } from "bun:test";

import type { BundleFile, CandidateBundle } from "../tools/kit/bundle.ts";
import { checkConsistency } from "../tools/tier1-deterministic/consistency/check.ts";
import {
  CONSISTENCY_METRIC_VERSION,
  consistencyOutcome,
} from "../tools/tier1-deterministic/consistency/evaluate.ts";

function file(path: string, content: string): BundleFile {
  return { path, content, bytes: content.length };
}

const BOOK = file(
  "src/de/example/Book.java",
  `package de.example;
public class Book {
  private final String title;
  public Book(String title) { this.title = title; }
  public String storageLocation() { return "A1"; }
  public String label() { return title; }
  public boolean reserve() { return true; }
}`,
);

const BOOK_TEST = file(
  "test/de/example/BookTest.java",
  `package de.example;
import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;
class BookTest {
  @Test void label() { assertEquals("Dune", new Book("Dune").label()); }
}`,
);

function bundle(statement: string, solution: BundleFile[] = [BOOK]): CandidateBundle {
  return {
    root: ".",
    statement: `The class Book is given.\n\n${statement}`,
    statementPath: "problem-statement.md",
    template: solution,
    solution,
    tests: [BOOK_TEST],
  };
}

function ungrounded(statement: string, solution?: BundleFile[]): string[] {
  return checkConsistency(bundle(statement, solution))
    .residuals.filter((residual) => residual.kind === "ungrounded_statement_identifier")
    .map((residual) => residual.detail);
}

describe("consistency code spans", () => {
  test("a span continuing over one line ending is read as one span", () => {
    expect(
      ungrounded(
        "Implement `public String\nstorageLocation()` to return the shelf code; and implement `public String\nlabel()` to return the title.",
      ),
    ).toEqual([]);
  });

  test("a span over one line ending is still checked", () => {
    expect(ungrounded("Implement `public String\nshelfCode()` to return the code.")).toEqual([
      "the statement refers to `shelfCode`, which appears in no generated artifact",
    ]);
  });

  test("a blank line ends a span", () => {
    expect(ungrounded("Use `label\n\nlater` here.")).toEqual([]);
  });
});

describe("consistency spans that are not API references", () => {
  test("a variable declared by a worked example is not reported", () => {
    expect(
      ungrounded(
        "| Step | Call | Result |\n| --- | --- | --- |\n| 1 | `boolean r1 = b.reserve();` | `r1` is `true` |",
      ),
    ).toEqual([]);
  });

  test("unqualified indexed array values are placeholders, independently of their name", () => {
    for (const name of ["answer", "values", "segments", "items", "data_parts"])
      expect(ungrounded(`The returned arrays are \`${name}[0]\` and \`${name}[1]\`.`)).toEqual([]);
    expect(ungrounded("Read `this.missingValues[0]`.")).toContain(
      "the statement refers to `missingValues`, which appears in no generated artifact",
    );
    expect(ungrounded("Read `Book.missingValues[0]`.")).toContain(
      "the statement refers to `missingValues`, which appears in no generated artifact",
    );
    expect(ungrounded("Call `missingValues()` first.")).toContain(
      "the statement refers to `missingValues`, which appears in no generated artifact",
    );
  });

  test("a field declared with a modifier is still checked", () => {
    expect(ungrounded("Declare `private static final int CAPACITY = 10;` in `Book`.")).toEqual([
      "the statement refers to `CAPACITY`, which appears in no generated artifact",
    ]);
  });

  test("an undeclared method inside a worked example is still reported", () => {
    expect(ungrounded("| 1 | `boolean r1 = b.reserveAll();` | `true` |")).toEqual([
      "the statement refers to `reserveAll`, which appears in no generated artifact",
    ]);
  });

  test("expected output in a code span is not reported", () => {
    expect(ungrounded("For example, the label is `Dune by Frank Herbert (ISBN 123)`.")).toEqual([]);
  });

  test("a placeholder in expected output is not reported", () => {
    expect(ungrounded("The label reads `Book at <location>`; `<location>` is the shelf.")).toEqual(
      [],
    );
  });

  test("Java keywords in output labels are not reported", () => {
    expect(ungrounded("Each line reads `if=` or `switch=` followed by the value.")).toEqual([]);
  });

  test("a call with arguments but no prose words is still checked", () => {
    expect(ungrounded("Call `Book.lable()` to get the title.")).toEqual([
      "the statement refers to `lable`, which appears in no generated artifact",
    ]);
  });

  test("a member chain through a JDK type is not reported", () => {
    expect(
      ungrounded("Use `String.endsWith(...)`, `Math.max(a, b)` and `System.out.println(...)`."),
    ).toEqual([]);
  });

  test("a JDK type named on its own that no artifact uses is still reported", () => {
    expect(ungrounded("`label()` throws an `IllegalArgumentException` for a blank title.")).toEqual(
      [
        "the statement refers to `IllegalArgumentException`, which appears in no generated artifact",
      ],
    );
  });

  test("an unqualified name the artifacts lack is still reported", () => {
    expect(ungrounded("Call `endsWithIsbn(...)` first.")).toEqual([
      "the statement refers to `endsWithIsbn`, which appears in no generated artifact",
    ]);
  });
});

describe("consistency package check", () => {
  const exercise = file(
    "src/de/tum/cit/aet/exgen/exercise/Book.java",
    'package de.tum.cit.aet.exgen.exercise;\npublic class Book { public String label() { return ""; } }',
  );

  test("a package the artifacts do not declare is reported", () => {
    expect(
      ungrounded("All classes live in the package `de.tum.cit.aet.exercise`.", [exercise]),
    ).toEqual([
      "the statement names the package `de.tum.cit.aet.exercise`, which no generated artifact declares",
    ]);
  });

  test("the declared package, a parent package and a qualified type are accepted", () => {
    expect(
      ungrounded(
        "Classes live in `de.tum.cit.aet.exgen.exercise`, below `de.tum.cit.aet`; see `de.tum.cit.aet.exgen.exercise.Book`.",
        [exercise],
      ),
    ).toEqual([]);
  });

  test("the type a qualified name ends in is still checked", () => {
    expect(ungrounded("See `de.tum.cit.aet.exgen.exercise.Bok`.", [exercise])).toEqual([
      "the statement refers to `Bok`, which appears in no generated artifact",
    ]);
  });

  test("a member chain that does not start like a declared package is checked name by name", () => {
    const shelf = file(
      "src/de/example/Shelf.java",
      "package de.example;\npublic class Shelf { Shelf shelf; Shelf location; String code; }",
    );
    expect(ungrounded("Return `shelf.location.code` or `shelf.location.mark`.", [shelf])).toEqual([
      "the statement refers to `mark`, which appears in no generated artifact",
    ]);
  });

  test("JDK packages are not checked", () => {
    expect(ungrounded("Use `java.util.List` for the shelf.", [exercise])).toEqual([]);
  });
});

describe("consistency gate", () => {
  const client = file(
    "src/de/example/Client.java",
    'package de.example;\npublic class Client { public static void main(String[] a) { System.out.println(new Book("x").label()); } }',
  );

  test("an unmentioned driver type is counted but does not fail the gate", () => {
    const report = checkConsistency(bundle("Implement `label()`.", [BOOK, client]));
    expect(report.counts.unmentioned_public_api).toBe(1);
    const outcome = consistencyOutcome(report);
    expect(outcome.gate).toEqual({ metricId: "consistency.satisfied", satisfied: true });
  });

  test("an ungrounded identifier still fails the gate", () => {
    const outcome = consistencyOutcome(checkConsistency(bundle("Call `Book.lable()`.")));
    expect(outcome.gate).toEqual({ metricId: "consistency.satisfied", satisfied: false });
  });

  test("every consistency score carries metric version 2", () => {
    expect(CONSISTENCY_METRIC_VERSION).toBe("2");
    const outcome = consistencyOutcome(checkConsistency(bundle("Implement `label()`.")));
    expect(new Set(outcome.scores.map((score) => score.metric_version))).toEqual(new Set(["2"]));
  });
});
