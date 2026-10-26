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
/** Artemis colours diagram elements by test result; before a submission they are grey. */
const TESTS_COLOR = /testsColor\([^)]*\)/g;

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
  const withoutTests = statement.replace(
    TASK_MARKER,
    (_marker, title: string) => `[task][${title.trim()}]`,
  );
  const sources = [...withoutTests.matchAll(DIAGRAM)].map((match) =>
    (match[1] ?? "").replace(TESTS_COLOR, "grey"),
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
  const diagrams = await Promise.all(sources.map((source) => render(source)));
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
