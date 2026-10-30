import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import type { EvaluationScore } from "../src/evaluation/contracts.ts";
import { templateDiff } from "../tools/tier3-expert-rating/builder/diff.ts";
import { automaticFindings } from "../tools/tier3-expert-rating/builder/findings.ts";
import {
  INSTRUMENT_DOCUMENT,
  instrumentDocument,
} from "../tools/tier3-expert-rating/builder/instrument-doc.ts";
import {
  raterStatement,
  readTasks,
  withArtemisTheme,
} from "../tools/tier3-expert-rating/builder/statement.ts";
import { INSTRUMENT_PATH, loadInstrument } from "../tools/tier3-expert-rating/builder/study.ts";
import { testOverview } from "../tools/tier3-expert-rating/builder/tests.ts";
import {
  type AnswerIssue,
  answerIssues,
  type InstrumentSource,
  instrumentSourceSchema,
  type Item,
  normalizeAnswers,
  resolveInstrument,
  type SectionAnswers,
} from "../tools/tier3-expert-rating/shared/instrument.ts";
import { planProblems } from "../tools/tier3-expert-rating/shared/plan.ts";

const instrument = await loadInstrument();
const source: InstrumentSource = instrumentSourceSchema.parse(
  parse(await readFile(INSTRUMENT_PATH, "utf8")),
);
const cases = JSON.parse(
  await readFile("tools/tier3-expert-rating/shared/answer-rules.cases.json", "utf8"),
) as {
  issues: Array<{ name: string; items: string[]; answers: unknown; issues: AnswerIssue[] }>;
  normalized: Array<{
    name: string;
    items: string[];
    answers: unknown;
    normalized: SectionAnswers;
  }>;
};
const items = instrument.questionnaire.parts.flatMap((part) => part.items);
const itemOf = (id: string): Item => {
  const item = [
    ...items,
    ...instrument.background.items,
    ...instrument.exit.items,
    ...instrument.briefs.items,
  ].find((candidate) => candidate.id === id);
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

  // The server applies the same rules (exgen.survey.study.AnswerRules) to the same cases.
  const itemsOf = (ids: string[]) =>
    ids.flatMap((id) =>
      id === "part:D" ? (instrument.questionnaire.parts[3]?.items ?? []) : [itemOf(id)],
    );
  for (const rule of cases.issues) {
    test(`answer rules: ${rule.name}`, () => {
      expect(answerIssues(itemsOf(rule.items), rule.answers as SectionAnswers)).toEqual(
        rule.issues,
      );
    });
  }
  for (const rule of cases.normalized) {
    test(`stored answers: ${rule.name}`, () => {
      expect(normalizeAnswers(itemsOf(rule.items), rule.answers as SectionAnswers)).toEqual(
        rule.normalized,
      );
    });
  }

  test("fills the introduction's placeholders with the materiality rule and an exercise's minutes", () => {
    const bodies = instrument.onboarding.pages.map((page) => page.body).join("\n");
    expect(bodies).not.toMatch(/\{[a-z_]+\}/);
    const minutes = instrument.questionnaire.parts.reduce((sum, part) => sum + part.minutes, 0);
    expect(bodies).toContain(`about ${minutes} minutes per exercise`);
    expect(bodies).toContain(instrument.materiality_rule.trim());
  });

  test("ends with feedback on the briefs, and has no practice exercise", () => {
    expect(instrument.briefs.items.map((item) => item.id)).toEqual(["BR1", "BR2", "BR3"]);
    expect("calibration" in instrument).toBe(false);
  });

  test("hints at a place only in material the part has opened", () => {
    let opened: string[] = [];
    for (const part of instrument.questionnaire.parts) {
      opened = [...opened, ...part.material];
      for (const item of part.items) {
        if (item.kind !== "choice") continue;
        const where = item.options.find((option) => option.detail?.label === "Where")?.detail;
        if (where === undefined) continue;
        expect(where.hint, item.id).toBeDefined();
        if (/\bfile\b/.test(where.hint ?? "")) expect(opened, item.id).toContain("template");
        if (/\btest\b/.test(where.hint ?? "")) expect(opened, item.id).toContain("tests");
      }
    }
  });

  describe("refuses a source", () => {
    const text = (id: string, extra: object = {}): Item => ({
      kind: "text",
      id,
      prompt: "Anything else?",
      required: false,
      ...extra,
    });

    test("with a calibration section", () => {
      const result = instrumentSourceSchema.safeParse({
        ...source,
        calibration: { title: "Practice", intro: "Practise.", items: ["CL1"] },
      });
      expect(result.success).toBe(false);
    });

    test("that defines an item twice, also between the exit survey and the briefs", () => {
      const briefs = { ...source.briefs, items: [...source.briefs.items, text("X8")] };
      expect(() => resolveInstrument({ ...source, briefs })).toThrow(
        "instrument item X8 is defined twice",
      );
    });

    test("whose condition refers to another section", () => {
      const briefs = {
        ...source.briefs,
        items: [text("BR9", { required: true, optional_when: { item: "RD2", value: 5 } })],
      };
      expect(() => resolveInstrument({ ...source, briefs })).toThrow(
        "BR9 depends on RD2, which is not in its section",
      );
    });
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
      ["F1", "The sample solution declares a type the problem statement never names", ["Helper"]],
      ["F2", "The problem statement and the code disagree", ["detail"]],
      [
        "F3",
        "A requirement of the problem statement is not tested",
        ["“Bounds are included.”: no test uses a bound"],
      ],
      [
        "F4",
        "No test checks an exception the problem statement names",
        ["IllegalArgumentException"],
      ],
      [
        "F5",
        "No test refers to a member the problem statement declares",
        ["area()", "perimeter()"],
      ],
      ["F6", "No test uses a value the problem statement gives", ["100"]],
      ["F7", "A test asserts nothing", ["testNothing"]],
      ["F8", "1 of 2 tests has no failure message of its own", ["test1"]],
      ["F9", "The sample solution does not use a construct the exercise requires", ["no loop"]],
      ["F10", "The sample solution uses a construct the exercise forbids", ["stream"]],
      ["F11", "The sample solution's complexity is outside the expected range", []],
    ]);
    // An unnamed type does not fail the consistency gate, so it is only shown as information.
    expect(findings.items.slice(0, 2).map((item) => item.severity)).toEqual(["info", "warning"]);
    expect(findings.metrics).toEqual([
      { label: "Tests per task", value: "1; 1 more test belongs to no task" },
    ]);
  });

  test("shows no model-assisted or reference result, and no metric the campaign does not measure", () => {
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
    // Every exercise passed the gates, which raters are told; coverage is never measured in a
    // campaign, so neither is a metric raters see.
    expect(findings.metrics).toEqual([]);
  });
});
