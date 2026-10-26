/**
 * The problem statement as raters see it. Artemis task markers keep their title but lose the tests
 * they list, because the tests belong to Part C, and diagrams are rendered ahead of time so the
 * survey never sends exercise content to a PlantUML server.
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

/**
 * Artemis' diagram theme (src/main/resources/puml/puml-theme-artemislight.puml in ls1intum/Artemis,
 * MIT License, Copyright (c) TUM Applied Education Technologies), which its server adds right after
 * `@startuml` unless the diagram sets a theme of its own. The Smetana layout needs no Graphviz.
 */
const ARTEMIS_THEME = `!pragma layout smetana
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

/** A diagram as Artemis renders it: with its theme, unless the diagram has one. */
export function withArtemisTheme(source: string): string {
  return /^\s*!theme\b/m.test(source)
    ? source
    : source.replace(/^@startuml[^\n]*\n?/, (start) => `${start.trimEnd()}\n${ARTEMIS_THEME}\n`);
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

/** Render one PlantUML diagram to SVG. */
export type DiagramRenderer = (source: string) => Promise<string>;

export interface RaterStatement {
  markdown: string;
  diagrams: string[];
  /** How the statement shows its diagrams. */
  presentation: "none" | "rendered" | "source";
}

export async function raterStatement(
  statement: string,
  render: DiagramRenderer | undefined,
): Promise<RaterStatement> {
  // A task that lists no tests is marked, since Artemis then says "No tests" instead of "No results".
  const withoutTests = statement.replace(
    TASK_MARKER,
    (_marker, title: string, tests: string | undefined) =>
      `[task${(tests ?? "").trim() === "" ? ":untested" : ""}][${title.trim()}]`,
  );
  const sources = [...withoutTests.matchAll(DIAGRAM)].map((match) =>
    (match[1] ?? "").replace(TESTS_COLOR, (_color, _test, _call, offset: number, source: string) =>
      source[offset - 1] === "#" && ELEMENT_LINE.test(lineAt(source, offset))
        ? "lightgrey"
        : "grey",
    ),
  );
  if (sources.length === 0) {
    return { markdown: withoutTests, diagrams: [], presentation: "none" };
  }
  if (render === undefined) {
    let index = 0;
    const markdown = withoutTests.replace(
      DIAGRAM,
      () => `\`\`\`plantuml\n${sources[index++]}\n\`\`\``,
    );
    return { markdown, diagrams: [], presentation: "source" };
  }
  const diagrams = await Promise.all(sources.map((source) => render(withArtemisTheme(source))));
  let index = 0;
  const markdown = withoutTests.replace(DIAGRAM, () => {
    index += 1;
    return `![Diagram ${index}](diagram:${index - 1})`;
  });
  return { markdown, diagrams, presentation: "rendered" };
}

/**
 * Render through plantuml.jar in its sandbox profile, which blocks every file and URL access a
 * diagram could request. This is how Artemis renders statements on its own server.
 */
export function plantumlRenderer(jar: string): DiagramRenderer {
  return async (source) => {
    // Without -nometadata, the SVG carries the encoded diagram source, which blinding cannot reach.
    const command = ["java", "-jar", jar, "-tsvg", "-nometadata", "-pipe", "-charset", "UTF-8"];
    const child = Bun.spawn(command, {
      stdin: new TextEncoder().encode(source),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PLANTUML_SECURITY_PROFILE: "SANDBOX" },
    });
    const [code, svg, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0 || !svg.includes("<svg")) {
      throw new Error(`PlantUML could not render a diagram: ${error.trim() || `exit ${code}`}`);
    }
    return svg;
  };
}
