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
      ["GOAL", "SCOPE", "SUPPORT"],
      ["FIT", "FEEDBACK", "RD1"],
      ["RD2", "FIND"],
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
    expect(instrument.onboarding.pages[0]?.body).toContain(instrument.rating_example!.trim());
    expect(instrument.onboarding.pages[0]?.body).not.toContain("{rating_example}");
  });

  test("uses the same readiness scale in C and D and requires the evidence each answer needs", async () => {
    const { questionnaire } = await loadInstrumentVersion("7");
    const rd1 = questionnaire.parts[2]!.items.find(({ id }) => id === "RD1")!;
    const rd2 = questionnaire.parts[3]!.items.find(({ id }) => id === "RD2")!;
    expect({ ...rd1, id: "RD2" }).toEqual(rd2);
    expect(answerIssues([rd2], { RD2: { value: 5 } })).toEqual([]);
    expect(answerIssues([rd2], { RD2: { value: 3 } })).not.toEqual([]);
    expect(answerIssues([rd2], { RD2: { value: "cannot_assess" } })).not.toEqual([]);
    expect(
      answerIssues([rd2], { RD2: { value: 3, text: "Fix the failing boundary test." } }),
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
