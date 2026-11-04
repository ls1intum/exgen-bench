import { analyseJavaUnit, type JavaUnit } from "./java/structure.ts";

export interface SourceFile {
  path: string;
  content: string;
}

export interface SourceChange {
  path: string;
  change: "added" | "modified" | "removed";
  /** The template's content, absent for an added file. */
  before?: string;
  /** The solution's content, absent for a removed file. */
  after?: string;
}

/** Build configuration and repository metadata, which differ between the two repositories by name. */
const NOT_STUDENT_WORK =
  /(^|\/)\.|(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradlew(\.bat)?)$/;

/** Test sources a submission repository may carry; a student's work is the code they test. */
const TEST_SOURCE = /^tests?\/|(^|\/)src\/test\//;

/** JUnit's test annotations, by simple name. */
const TEST_ANNOTATIONS = new Set([
  "Test",
  "ParameterizedTest",
  "RepeatedTest",
  "TestFactory",
  "TestTemplate",
]);

const TYPE_KEYWORDS = new Set(["class", "interface", "enum"]);

/** Java files that declare no class: package annotations and module descriptors. */
const NOT_A_CLASS = /(^|\/)(package-info|module-info)\.java$/;

export function isStudentWork(path: string): boolean {
  return !NOT_STUDENT_WORK.test(path);
}

/**
 * What a student has to add, change or remove: every file outside build configuration and
 * repository metadata whose content differs between template and solution, by path.
 */
export function changedSources(template: SourceFile[], solution: SourceFile[]): SourceChange[] {
  const sources = (files: SourceFile[]) =>
    new Map(
      files.filter((file) => isStudentWork(file.path)).map((file) => [file.path, file.content]),
    );
  const before = sources(template);
  const after = sources(solution);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const old = before.get(path);
    const next = after.get(path);
    if (old === next) return [];
    return [
      {
        path,
        change: old === undefined ? "added" : next === undefined ? "removed" : "modified",
        ...(old === undefined ? {} : { before: old }),
        ...(next === undefined ? {} : { after: next }),
      } satisfies SourceChange,
    ];
  });
}

function analyse(path: string, content: string): JavaUnit | null {
  try {
    return analyseJavaUnit(path, content);
  } catch {
    return null;
  }
}

function packagePrefix(unit: JavaUnit | null, content: string): string {
  const name = unit?.packageName ?? /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1] ?? null;
  return name === null ? "" : `${name}.`;
}

/** The fully qualified name of the class a Java source file is named after. */
export function javaClassName(path: string, content: string): string {
  const simple = (path.split("/").at(-1) ?? path).replace(/\.java$/, "");
  return packagePrefix(analyse(path, content), content) + simple;
}

/**
 * The fully qualified names of every top-level type a Java source file declares, which may be more
 * than the one it is named after; the file's name alone when the source cannot be lexed.
 */
export function javaTypeNames(path: string, content: string): string[] {
  const unit = analyse(path, content);
  if (unit === null) return [javaClassName(path, content)];
  const prefix = packagePrefix(unit, content);
  const names: string[] = [];
  unit.tokens.forEach((token, index) => {
    if (unit.depths[index] !== 0 || unit.tokens[index - 1]?.value === ".") return;
    const declares =
      (token.kind === "keyword" && TYPE_KEYWORDS.has(token.value)) ||
      (token.value === "record" && unit.tokens[index + 2]?.value === "(") ||
      (token.value === "interface" && unit.tokens[index - 1]?.value === "@");
    const name = unit.tokens[index + 1];
    if (declares && name?.kind === "identifier") names.push(prefix + name.value);
  });
  return names.length === 0 ? [javaClassName(path, content)] : names;
}

/**
 * Whether a source declares JUnit tests, as in exercises whose students write tests themselves:
 * a JUnit import or a JUnit test annotation, read from tokens so comments and strings never count.
 */
export function declaresTests(path: string, content: string): boolean {
  const unit = analyse(path, content);
  if (unit === null) return false;
  if (unit.imports.some((name) => /^(static\.)?org\.junit\./.test(name))) return true;
  return unit.tokens.some((token, index) => {
    if (token.value !== "@") return false;
    let last = index + 1;
    while (unit.tokens[last + 1]?.value === "." && unit.tokens[last + 2]?.kind === "identifier") {
      last += 2;
    }
    return TEST_ANNOTATIONS.has(unit.tokens[last]?.value ?? "");
  });
}

/**
 * The classes a student writes or changes: every top-level type of the Java sources the solution
 * adds or modifies, outside test sources and sources that declare tests, as fully qualified names
 * in sorted order. This is the scope of mutation analysis.
 */
export function changedClassNames(template: SourceFile[], solution: SourceFile[]): string[] {
  const names = changedSources(template, solution).flatMap((change) =>
    change.after === undefined ||
    !change.path.endsWith(".java") ||
    TEST_SOURCE.test(change.path) ||
    NOT_A_CLASS.test(change.path) ||
    declaresTests(change.path, change.after)
      ? []
      : javaTypeNames(change.path, change.after),
  );
  return [...new Set(names)].sort();
}
