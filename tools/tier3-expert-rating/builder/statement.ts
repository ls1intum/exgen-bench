/**
 * The problem statement as raters see it. Artemis task markers keep their title but lose the tests
 * they list, because the tests belong to Part C. Diagrams stay PlantUML source, prepared as Artemis
 * prepares them before a submission; the survey renders them in the rater's browser with
 * PlantUML's own engine, so no exercise content reaches a PlantUML server.
 */

/** Artemis' own task syntax: `[task][Title](testA,testB)`; test names may contain parentheses. */
const TASK_MARKER =
  /\[task]\[([^[\]]+)]\(((?:[^(),]+(?:\([^()]*\)[^(),]*)?(?:,[^(),]+(?:\([^()]*\)[^(),]*)?)*)?)\)/g;
const TEST_ID = /^<testid>(\d+)<\/testid>$/;
/** A PlantUML diagram, with the Markdown fence around it when there is one. */
const DIAGRAM = /(?:```plantuml\s*\n)?(@startuml[\s\S]*?@enduml)(?:\s*\n```)?/g;
/**
 * Artemis colours diagram elements by test result; before a submission they are grey. The pattern
 * is Artemis' own, which allows one nested call such as `testsColor(testBubbleSort())`. An element
 * filled with Artemis' grey keeps its black text hard to read, so fills become light grey; text
 * colours stay grey.
 */
const TESTS_COLOR = /testsColor\((\s*[^()\s]+(?:[ \t]+[^()\s]+)*([ \t]*\([^()]*\))?)\)/g;

/** PlantUML's own layout engine, which renders in the browser without Graphviz. */
const SMETANA = "!pragma layout smetana";

/**
 * Artemis' diagram theme (src/main/resources/puml/puml-theme-artemislight.puml in ls1intum/Artemis,
 * MIT License, Copyright (c) TUM Applied Education Technologies), which its server adds right after
 * `@startuml` unless the diagram sets a theme of its own. It also selects the Smetana layout.
 */
const ARTEMIS_THEME = `${SMETANA}
skinparam ArrowFontSize 16
skinparam shadowing false
skinparam classAttributeIconSize 0
skinparam class {
    FontSize 20
    BackgroundColor white
    AttributeFontSize 16
    BorderColor black
    ArrowColor black
}`;

/**
 * A diagram as Artemis renders it: with Artemis' theme, unless the diagram has its own, and always
 * with a layout the browser engine can compute.
 */
export function withArtemisTheme(source: string): string {
  const header = [
    /^\s*!theme\b/m.test(source) ? null : ARTEMIS_THEME,
    /^\s*!theme\b/m.test(source) && !/^\s*!pragma\s+layout\b/m.test(source) ? SMETANA : null,
  ].filter((line): line is string => line !== null);
  return header.length === 0
    ? source
    : source.replace(
        /^@startuml[^\n]*\n?/,
        (start) => `${start.trimEnd()}\n${header.join("\n")}\n`,
      );
}

/**
 * A line that declares a diagram element. A colour after it fills the element, and a fill in grey
 * would hide its text, so it becomes light grey there; on a relationship line it colours the line.
 */
const ELEMENT_LINE = /^\s*(abstract\s+)?(class|interface|enum|package|object|annotation)\b/;

/** The whole line of a source that the given offset falls on. */
function lineAt(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  return source.slice(start, end === -1 ? undefined : end);
}

export interface Task {
  title: string;
  /** Test names, in the order the marker lists them. */
  tests: string[];
}

/** Artemis test cases by ID, for statements that reference tests as `<testid>N</testid>`. */
export type TestCatalog = ReadonlyMap<number, string>;

export function readTasks(statement: string, catalog: TestCatalog): Task[] {
  return [...statement.matchAll(TASK_MARKER)].map((match) => ({
    title: (match[1] ?? "").trim(),
    tests: (match[2] ?? "")
      .split(",")
      .map((reference) => reference.trim())
      .filter((reference) => reference !== "")
      .map((reference) => {
        const id = TEST_ID.exec(reference)?.[1];
        if (id === undefined) {
          return reference;
        }
        const name = catalog.get(Number(id));
        if (name === undefined) {
          throw new Error(`the statement references test ID ${id}, which the test catalog lacks`);
        }
        return name;
      }),
  }));
}

/**
 * The statement with its tasks' tests removed and its diagrams as `plantuml` code blocks, each in
 * Artemis' colours for an exercise without a submission and with Artemis' theme.
 */
export function raterStatement(statement: string): string {
  // A task that lists no tests is marked, since Artemis then says "No tests" instead of "No results".
  const withoutTests = statement.replace(
    TASK_MARKER,
    (_marker, title: string, tests: string | undefined) =>
      `[task${(tests ?? "").trim() === "" ? ":untested" : ""}][${title.trim()}]`,
  );
  return withoutTests.replace(DIAGRAM, (_diagram, source: string) => {
    const greyed = source.replace(
      TESTS_COLOR,
      (_color, _test, _call, offset: number, text: string) =>
        text[offset - 1] === "#" && ELEMENT_LINE.test(lineAt(text, offset)) ? "lightgrey" : "grey",
    );
    return `\`\`\`plantuml\n${withArtemisTheme(greyed)}\n\`\`\``;
  });
}
