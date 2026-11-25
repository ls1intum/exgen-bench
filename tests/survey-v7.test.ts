import { describe, expect, test } from "bun:test";

import { loadInstrumentVersion } from "../tools/tier3-expert-rating/builder/study.ts";
import { answerIssues, materialThrough } from "../tools/tier3-expert-rating/shared/instrument.ts";
import { groupStarterFiles } from "../tools/tier3-expert-rating/shared/starter-files.ts";

describe("main study rubric", () => {
  test("releases exactly the material needed for each set of decisions", async () => {
    const instrument = await loadInstrumentVersion("7");
    expect(
      instrument.questionnaire.parts.map((part) =>
        part.items.filter((item) => item.kind === "choice").map((item) => item.id),
      ),
    ).toEqual([
      ["SPEC"],
      ["GOAL", "SUPPORT"],
      ["FIT", "FEEDBACK", "RD1"],
      ["RD2", "GRADE", "FIND"],
    ]);
    expect(materialThrough(instrument, "A")).toEqual(["statement", "template"]);
    expect(materialThrough(instrument, "C")).toEqual([
      "statement",
      "template",
      "brief",
      "diff",
      "tests",
    ]);
    expect(instrument.briefs.items).toEqual([]);
    expect(instrument.rating_example).toBeDefined();
    for (const page of instrument.onboarding.pages) {
      expect(page.body).not.toContain(instrument.rating_example!.trim());
      expect(page.body).not.toContain("{rating_example}");
    }
  });

  test("uses the same readiness scale in C and D and requires the evidence each answer needs", async () => {
    const { questionnaire } = await loadInstrumentVersion("7");
    const rd1 = questionnaire.parts[2]!.items.find(({ id }) => id === "RD1")!;
    const rd2 = questionnaire.parts[3]!.items.find(({ id }) => id === "RD2")!;
    if (rd1.kind !== "choice" || rd2.kind !== "choice")
      throw new Error("Missing readiness options");
    expect(rd1.prompt).toBe(rd2.prompt);
    expect(rd1.options).toEqual(rd2.options);
    expect(rd1.prompt).toContain("if anything");
    expect(rd1.note).toBe(rd2.note);
    expect(rd1.note).toContain("If you can identify changes the exercise needs, rate those.");
    expect(questionnaire.parts[3]?.opens).toContain("Check each finding you use");
    expect(answerIssues([rd2], { RD2: { value: 5 } })).toEqual([]);
    expect(answerIssues([rd2], { RD2: { value: 3 } })).not.toEqual([]);
    expect(answerIssues([rd2], { RD2: { value: "cannot_assess" } })).not.toEqual([]);
    expect(
      answerIssues([rd2], { RD2: { value: 3, text: "Fix the failing boundary test." } }),
    ).toEqual([]);
  });
  test("reports diagnostic problems without typing and requires an example for a claimed grading error", async () => {
    const { questionnaire } = await loadInstrumentVersion("7");
    const items = questionnaire.parts.flatMap((part) => part.items);
    const response = (id: string, value: string, choice?: string, text?: string) =>
      answerIssues(
        items.filter((item) => item.id === id),
        {
          [id]: {
            value,
            ...(choice === undefined ? {} : { choice }),
            ...(text === undefined ? {} : { text }),
          },
        },
      );
    expect(response("SPEC", "clarify", "missing")).toEqual([]);
    expect(response("SPEC", "clarify").length).toBe(1);
    expect(response("GOAL", "limited")).toEqual([]);
    expect(response("GOAL", "cannot_assess")).toEqual([]);
    expect(response("SUPPORT", "missing")).toEqual([]);
    expect(response("SUPPORT", "does_the_work")).toEqual([]);
    expect(response("SUPPORT", "both")).toEqual([]);
    expect(response("FIT", "no_mismatch")).toEqual([]);
    expect(response("FIT", "mismatch").length).toBe(1);
    expect(response("FEEDBACK", "change")).toEqual([]);
    expect(response("FEEDBACK", "cannot_assess")).toEqual([]);
    expect(response("GRADE", "no_case")).toEqual([]);
    expect(response("GRADE", "accepts_wrong").length).toBe(1);
    expect(
      response(
        "GRADE",
        "rejects_correct",
        undefined,
        "The empty input is allowed but test A deducts credit.",
      ),
    ).toEqual([]);
  });
});

test("source and exercise data stay in the starter tree, including explicitly named setup files", () => {
  const paths = [
    "src/main/java/Calculator.java",
    "src/main/resources/gradle/wrapper/test.txt",
    "src/main/resources/.sample.csv",
    "README.md",
    "settings.gradle.kts",
    "build.gradle",
    "gradle/wrapper/gradle-wrapper.properties",
    ".vscode/launch.json",
    ".gitignore",
  ];
  const files = paths.map((path) => ({ path, value: "original" }));
  const { main, setup } = groupStarterFiles(
    files,
    "Open build.gradle. Keep src/main/resources/gradle/wrapper/test.txt as it is.",
  );
  expect(main.map(({ path }) => path)).toEqual([...paths.slice(0, 4), "build.gradle"]);
  expect(setup.map(({ path }) => path)).toEqual([
    "settings.gradle.kts",
    "gradle/wrapper/gradle-wrapper.properties",
    ".vscode/launch.json",
    ".gitignore",
  ]);
  expect(groupStarterFiles(files, "Open build.gradle.kts").setup).toContainEqual({
    path: "build.gradle",
    value: "original",
  });
});

test("keeps a setup file named in the starter instructions in the main tree", () => {
  const readme = {
    path: "README.md",
    content: "Edit Gradle's `settings.gradle.kts` to complete the task.",
  };
  const settings = { path: "settings.gradle.kts", content: 'rootProject.name = "example"' };
  expect(groupStarterFiles([readme, settings], "")).toEqual({
    main: [readme, settings],
    setup: [],
  });
});
