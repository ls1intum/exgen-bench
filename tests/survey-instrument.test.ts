import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { strFromU8, unzipSync } from "fflate";

import type { EvaluationScore } from "../src/evaluation/contracts.ts";
import { simulateExport } from "../tools/tier3-expert-rating/analysis/simulate.ts";
import { templateDiff } from "../tools/tier3-expert-rating/builder/diff.ts";
import { automaticFindings } from "../tools/tier3-expert-rating/builder/findings.ts";
import {
  raterStatement,
  readTasks,
  withArtemisTheme,
} from "../tools/tier3-expert-rating/builder/statement.ts";
import { testOverview } from "../tools/tier3-expert-rating/builder/tests.ts";
import {
  INSTRUMENT_DOCUMENT,
  instrumentDocument,
} from "../tools/tier3-expert-rating/server/instrument-doc.ts";
import { loadInstrument } from "../tools/tier3-expert-rating/server/study.ts";
import { currentStep } from "../tools/tier3-expert-rating/shared/flow.ts";
import {
  answerIssues,
  type Item,
  normalizeAnswers,
} from "../tools/tier3-expert-rating/shared/instrument.ts";
import { planProblems } from "../tools/tier3-expert-rating/shared/plan.ts";
import { readinessClass } from "../tools/tier3-expert-rating/shared/readiness.ts";

const instrument = await loadInstrument();
const items = instrument.questionnaire.parts.flatMap((part) => part.items);
const itemOf = (id: string): Item => {
  const item = [...items, ...instrument.background.items, ...instrument.exit.items].find(
    (candidate) => candidate.id === id,
  );
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
};

describe("instrument", () => {
  test("asks the eleven exercise items, the two finding items, and readiness twice", () => {
    expect(items.filter((item) => item.kind === "choice").map((item) => item.id)).toEqual([
      "CL1",
      "CL2",
      "SO1",
      "OA1",
      "OA2",
      "OA3",
      "OA4",
      "DF1",
      "SC1",
      "SC2",
      "FB1",
      "RD1",
      "AF1",
      "AF2",
      "RD2",
    ]);
  });

  test("requires the reason a No asks for", () => {
    const cl1 = itemOf("CL1");
    expect(answerIssues([cl1], { CL1: { value: "no" } })).toEqual([
      { item: "CL1", message: "needs “Where”" },
    ]);
    expect(answerIssues([cl1], { CL1: { value: "no", text: "  " } })).toHaveLength(1);
    expect(answerIssues([cl1], { CL1: { value: "no", text: "Task 2" } })).toEqual([]);
    expect(answerIssues([cl1], { CL1: { value: "yes" } })).toEqual([]);
  });

  test("requires the direction of a difficulty misfit", () => {
    const df1 = itemOf("DF1");
    expect(answerIssues([df1], { DF1: { value: "no", text: "much code" } })).toEqual([
      { item: "DF1", message: "needs one of the follow-up choices" },
    ]);
    expect(
      answerIssues([df1], { DF1: { value: "no", choice: "too_hard", text: "much code" } }),
    ).toEqual([]);
    expect(answerIssues([df1], { DF1: { value: "yes", choice: "too_hard" } })).toEqual([
      { item: "DF1", message: "has a follow-up choice the option does not offer" },
    ]);
  });

  test("makes the most important change optional only when the exercise deploys as is", () => {
    const part = instrument.questionnaire.parts[3];
    if (part === undefined) throw new Error("no Part D");
    const answered = { AF1: { value: "na" }, AF2: { value: "na" } };
    const missing = (rd2: number) =>
      answerIssues(part.items, { ...answered, RD2: { value: rd2 } }).map((issue) => issue.item);
    expect(missing(4)).toEqual(["CHG"]);
    expect(missing(5)).toEqual([]);
  });

  test("refuses unknown options and items, and an exclusive option combined with others", () => {
    expect(answerIssues([itemOf("B2")], { B2: { value: "forever" } })).toEqual([
      { item: "B2", message: "has an option that does not exist" },
    ]);
    expect(answerIssues([itemOf("B2")], { B2: { value: "3_to_5" }, X9: { text: "?" } })).toEqual([
      { item: "X9", message: "is not part of this section" },
    ]);
    expect(answerIssues([itemOf("B5")], { B5: { values: ["none", "student"] } })).toEqual([
      { item: "B5", message: "combines an exclusive option with another" },
    ]);
  });

  test("keeps only what the chosen option asks for when answers are stored", () => {
    expect(
      normalizeAnswers([itemOf("CL1"), itemOf("REM")], {
        CL1: { value: "yes", text: "left over from an earlier No", choice: "x" },
        REM: { text: "  none  " },
      }),
    ).toEqual({ CL1: { value: "yes" }, REM: { text: "none" } });
  });

  test("is documented by the INSTRUMENT.md generated from it", async () => {
    const formatter = Bun.spawn(
      [process.execPath, "fmt", "--no-script", "--stdin-filepath", INSTRUMENT_DOCUMENT],
      { stdin: new TextEncoder().encode(instrumentDocument(instrument)), stdout: "pipe" },
    );
    const generated = await new Response(formatter.stdout).text();
    expect(generated).toBe(await readFile(INSTRUMENT_DOCUMENT, "utf8"));
  });
});

describe("readiness", () => {
  test("groups the five levels into the three pre-registered classes", () => {
    expect([1, 2, 3, 4, 5].map(readinessClass)).toEqual([
      "not_usable",
      "not_usable",
      "usable",
      "ready",
      "ready",
    ]);
  });
});

describe("assignment plan", () => {
  // The plan of the study design: eight raters, three exercises each, one per course phase.
  const exercises = ["E", "M", "L"].flatMap((phase) =>
    [1, 2, 3, 4].map((index) => ({
      code: `${phase}${index}`,
      phase: ({ E: "early", M: "middle", L: "late" } as const)[phase as "E" | "M" | "L"],
    })),
  );
  const raters = [
    ["E1", "M1", "L1"],
    ["M2", "E1", "L2"],
    ["M1", "L3", "E2"],
    ["E2", "L4", "M2"],
    ["L1", "E3", "M3"],
    ["L2", "M4", "E3"],
    ["E4", "M3", "L3"],
    ["L4", "E4", "M4"],
  ].map((plan, index) => ({ id: `R${index + 1}`, exercises: plan }));

  test("accepts the study design's plan", () => {
    expect(planProblems(exercises, raters, 2)).toEqual([]);
  });

  test("refuses a plan that rates an exercise once, repeats a position, or isolates raters", () => {
    const broken = raters.map((rater) =>
      rater.id === "R2" ? { ...rater, exercises: ["E1", "M2", "L2"] } : rater,
    );
    expect(planProblems(exercises, broken, 2)).toEqual([
      "E1 is rated at the same position by two raters",
      "position 1 is unbalanced across phases (early 4, late 3, middle 1)",
      "position 2 is unbalanced across phases (early 2, late 2, middle 4)",
    ]);
    expect(planProblems(exercises, raters.slice(0, 1), 1)).toContain(
      "E2 is rated by 0 raters, not 1",
    );
    const twoGroups = [
      { id: "A", exercises: ["E1", "M1", "L1"] },
      { id: "B", exercises: ["M1", "L1", "E1"] },
    ];
    expect(
      planProblems(
        exercises.slice(0, 1).concat(exercises.slice(4, 5), exercises.slice(8, 9)),
        twoGroups,
        2,
      ),
    ).toContain("A and B share 3 exercises");
  });
});

describe("flow", () => {
  const progress = (submitted: string[], positions = [1, 2]) => ({
    declined: false,
    submitted: new Set(submitted),
    positions,
  });

  test("moves through the introduction, every part of every exercise, and the final survey", () => {
    const once = ["consent", "background", "onboarding", "calibration", "calibration_review"];
    expect(currentStep(progress([]))).toEqual({ kind: "consent" });
    expect(currentStep(progress(once))).toEqual({ kind: "part", position: 1, part: "A" });
    expect(currentStep(progress([...once, "exercise-1-A", "exercise-1-B"]))).toEqual({
      kind: "part",
      position: 1,
      part: "C",
    });
    const rated = ["A", "B", "C", "D"].flatMap((part) => [
      `exercise-1-${part}`,
      `exercise-2-${part}`,
    ]);
    expect(currentStep(progress([...once, ...rated]))).toEqual({ kind: "exit" });
    expect(currentStep(progress([...once, ...rated, "exit"]))).toEqual({ kind: "done" });
  });

  test("lets a reserve rater wait until exercises are assigned, and ends at a decline", () => {
    const once = ["consent", "background", "onboarding", "calibration", "calibration_review"];
    expect(currentStep(progress(once, []))).toEqual({ kind: "waiting" });
    expect(currentStep({ ...progress([]), declined: true })).toEqual({ kind: "declined" });
  });
});

describe("exercise material", () => {
  const statement = [
    "# Shapes",
    "",
    "1. [task][Compute the area](testArea,<testid>7</testid>)",
    "",
    "```plantuml",
    "@startuml",
    "class Circle #testsColor(testArea)",
    "@enduml",
    "```",
  ].join("\n");

  test("resolves task markers by test name and by Artemis test ID", () => {
    expect(readTasks(statement, new Map([[7, "testPerimeter"]]))).toEqual([
      { title: "Compute the area", tests: ["testArea", "testPerimeter"] },
    ]);
    expect(() => readTasks(statement, new Map())).toThrow("test ID 7");
  });

  test("keeps the task title but not its tests, and each diagram as prepared PlantUML source", () => {
    const rater = raterStatement(statement);
    expect(rater).toContain("[task][Compute the area]");
    expect(rater).not.toContain("testArea");
    expect(rater).toContain("```plantuml\n@startuml\n!pragma layout smetana\n");
    expect(rater).toContain("class Circle #lightgrey");
    // A bare diagram, as Artemis' templates write them, becomes a fenced one too.
    expect(raterStatement("@startuml\nclass A\n@enduml")).toStartWith("```plantuml\n@startuml\n");
  });

  test("greys out test colours as Artemis does, also around a nested call, and marks untested tasks", () => {
    const rater = raterStatement(
      [
        "1. [task][Sort](testBubbleSort())<br>",
        "2. [task][Explain]()",
        "@startuml",
        "class BubbleSort {",
        "<color:testsColor(testBubbleSort())>+performSort(List<Date>)</color>",
        "}",
        "@enduml",
      ].join("\n"),
    );
    expect(rater).toContain("[task][Sort]<br>");
    expect(rater).toContain("[task:untested][Explain]");
    expect(rater).toContain("<color:grey>+performSort(List<Date>)</color>");
  });

  test("fills elements in light grey but keeps relationship lines grey, as Artemis does", () => {
    const rater = raterStatement(
      [
        "@startuml",
        "abstract class SortStrategy #testsColor(testClass[SortStrategy])",
        "MergeSort -up-|> SortStrategy #testsColor(testClass[MergeSort])",
        "@enduml",
      ].join("\n"),
    );
    expect(rater).toContain("abstract class SortStrategy #lightgrey");
    expect(rater).toContain("MergeSort -up-|> SortStrategy #grey");
  });

  test("gives diagrams Artemis' theme unless they set their own, and always a browser layout", () => {
    expect(withArtemisTheme("@startuml\nclass A\n@enduml")).toContain("skinparam shadowing false");
    expect(withArtemisTheme("@startuml\n!theme plain\nclass A\n@enduml")).toBe(
      "@startuml\n!pragma layout smetana\n!theme plain\nclass A\n@enduml",
    );
    const laidOut = "@startuml\n!theme plain\n!pragma layout smetana\nclass A\n@enduml";
    expect(withArtemisTheme(laidOut)).toBe(laidOut);
  });

  test("diffs the student's source files, not build files or repository metadata", () => {
    const diff = templateDiff(
      [
        { path: "pom.xml", content: "<artifactId>a</artifactId>\n" },
        { path: ".gitignore", content: "target\n" },
        { path: ".github/workflows/build.yml", content: "on: push\n" },
        { path: "src/A.java", content: "class A {\n  int f() { return -1; }\n}\n" },
      ],
      [
        { path: "pom.xml", content: "<artifactId>a-Solution</artifactId>\n" },
        { path: ".gitignore", content: "target\nbuild\n" },
        { path: ".github/workflows/build.yml", content: "on: pull_request\n" },
        { path: "src/A.java", content: "class A {\n  int f() { return 1; }\n}\n" },
        { path: "src/B.java", content: "class B {}\n" },
      ],
    );
    expect(diff.map((file) => [file.path, file.change])).toEqual([
      ["src/A.java", "modified"],
      ["src/B.java", "added"],
    ]);
    expect(diff[0]?.hunks[0]?.lines.filter((line) => line.kind !== "context")).toEqual([
      { kind: "removed", text: "  int f() { return -1; }", old: 2 },
      { kind: "added", text: "  int f() { return 1; }", new: 2 },
    ]);
  });

  test("groups the template's failing tests by task and flags bare assertions", () => {
    expect(
      testOverview(
        [{ title: "Area", tests: ["testArea"] }],
        [
          { name: "testArea", message: "The area of a unit circle is pi." },
          { name: "test1", message: "expected: <1> but was: <0>" },
        ],
      ),
    ).toEqual([
      {
        task: "Area",
        tests: [{ name: "testArea", message: "The area of a unit circle is pi.", generic: false }],
      },
      {
        task: null,
        tests: [{ name: "test1", message: "expected: <1> but was: <0>", generic: true }],
      },
    ]);
    expect(() => testOverview([{ title: "Area", tests: ["testMissing"] }], [])).toThrow(
      "testMissing",
    );
  });
});

describe("automatic findings", () => {
  const score = (metric_id: string, fields: Partial<EvaluationScore>): EvaluationScore => ({
    metric_id,
    metric_version: "1",
    status: "ok",
    evidence: [],
    ...fields,
  });
  const tests = [
    { task: "Area", tests: [{ name: "testArea", message: "The area is pi.", generic: false }] },
    { task: null, tests: [{ name: "test1", message: "expected: <1>", generic: true }] },
  ];

  test("restates what the deterministic evaluators found, one finding per kind of problem", () => {
    const findings = automaticFindings(
      [
        {
          evaluator: { id: "consistency" },
          scores: [
            score("consistency.residual_count", {
              value: 2,
              evidence: ["unmentioned_public_api: Helper", "something_new: detail"],
            }),
          ],
        },
        {
          evaluator: { id: "promise-traceability" },
          scores: [
            score("promise.unwitnessed_claims", {
              value: 1,
              evidence: ['UNWITNESSED range — "Bounds are included." — no test uses a bound'],
            }),
            score("exception.assertthrows_ratio", {
              value: 0,
              evidence: ["UNWITNESSED IllegalArgumentException", "WITNESSED x"],
            }),
            score("api.member_reference_ratio", {
              value: 0.5,
              evidence: ["UNREFERENCED area()", "UNREFERENCED perimeter()"],
            }),
            score("boundary.literal_ratio", { value: 0.5, evidence: ["ABSENT 100"] }),
          ],
        },
        {
          evaluator: { id: "java-static" },
          scores: [
            score("tests.assertionless_methods", { value: 1, evidence: ["testNothing"] }),
            score("concept.required_constructs_present", { value: false, message: "no loop" }),
            score("concept.forbidden_constructs_absent", { value: false, evidence: ["stream"] }),
            score("complexity.within_bounds", { value: false }),
          ],
        },
      ],
      tests,
    );
    expect(findings.items.map((item) => [item.id, item.title, item.details])).toEqual([
      ["F1", "The solution declares a type the statement never names", ["Helper"]],
      ["F2", "The statement and the code disagree", ["detail"]],
      [
        "F3",
        "No test checks a requirement of the statement",
        ["“Bounds are included.”: no test uses a bound"],
      ],
      ["F4", "No test checks an exception the statement names", ["IllegalArgumentException"]],
      ["F5", "No test refers to a member the statement declares", ["area()", "perimeter()"]],
      ["F6", "No test uses a value the statement states", ["100"]],
      ["F7", "A test asserts nothing", ["testNothing"]],
      ["F8", "The solution does not use a construct the exercise requires", ["no loop"]],
      ["F9", "The solution uses a construct the exercise forbids", ["stream"]],
      ["F10", "The solution's complexity is outside the expected range", []],
      ["F11", "1 of 2 tests has no failure message of its own", ["test1"]],
    ]);
    expect(findings.metrics).toEqual([]);
  });

  test("shows no model-assisted or reference result, and summarises the oracle's metrics", () => {
    const findings = automaticFindings(
      [
        {
          evaluator: { id: "java-reference" },
          scores: [
            score("api.member_reference_ratio", { value: 0, evidence: ["UNREFERENCED f()"] }),
          ],
        },
        {
          evaluator: { id: "java-oracle" },
          scores: [
            score("oracle.satisfied", { value: true }),
            score("coverage.statement", { value: 0.904 }),
            score("mutation.score", { status: "not_applicable" }),
          ],
        },
      ],
      [{ task: null, tests: [{ name: "test1", message: "", generic: true }] }],
    );
    expect(findings.items.map((item) => item.title)).toEqual([
      "1 of 1 test has no failure message of its own",
    ]);
    expect(findings.items[0]?.severity).toBe("warning");
    expect(findings.metrics).toEqual([
      { label: "Build and gates", value: "Passed" },
      { label: "Statement coverage of the solution", value: "90 %" },
    ]);
  });
});

describe("simulation", () => {
  test("rates the study design's plan with a dropout, a backup, and tie breakers", async () => {
    const files = unzipSync(await simulateExport(1));
    const data = JSON.parse(strFromU8(files["data.json"] ?? new Uint8Array())) as {
      tables: { ratings: Array<{ rater_id: string; assignment: string; complete: boolean }> };
    };
    const ratings = data.tables.ratings.filter((rating) => rating.complete);
    expect(ratings.filter((rating) => rating.assignment !== "tie_breaker")).toHaveLength(24);
    expect(ratings.filter((rating) => rating.rater_id === "R8")).toHaveLength(1);
    expect(ratings.filter((rating) => rating.assignment === "backup")).toHaveLength(2);
    expect(
      ratings.filter((rating) => rating.assignment === "tie_breaker").length,
    ).toBeLessThanOrEqual(3);
  });
});
