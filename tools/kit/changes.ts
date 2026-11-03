import { analyseJavaUnit } from "./java/structure.ts";

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

/** The fully qualified name of the class a Java source file declares, from its package and name. */
export function javaClassName(path: string, content: string): string {
  const simple = (path.split("/").at(-1) ?? path).replace(/\.java$/, "");
  let packageName: string | null = null;
  try {
    packageName = analyseJavaUnit(path, content).packageName;
  } catch {
    packageName = /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1] ?? null;
  }
  return packageName === null ? simple : `${packageName}.${simple}`;
}

/**
 * The classes a student writes or changes: the Java sources the solution adds or modifies, outside
 * test sources, as fully qualified names in sorted order. This is the scope of mutation analysis.
 */
export function changedClassNames(template: SourceFile[], solution: SourceFile[]): string[] {
  const names = changedSources(template, solution).flatMap((change) =>
    change.after === undefined ||
    !change.path.endsWith(".java") ||
    TEST_SOURCE.test(change.path) ||
    NOT_A_CLASS.test(change.path)
      ? []
      : [javaClassName(change.path, change.after)],
  );
  return [...new Set(names)].sort();
}
