import { structuredPatch } from "diff";

import type { DiffFile } from "../shared/exercise.ts";

export interface SourceFile {
  path: string;
  content: string;
}

/** Build configuration and repository metadata, which differ between the two repositories by name. */
const NOT_STUDENT_WORK =
  /(^|\/)\.|(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradlew(\.bat)?)$/;

/**
 * What a student has to add or change: the template-to-solution difference of each source file, in
 * hunks with three lines of context. The solution itself is never shown, only these hunks.
 */
export function templateDiff(template: SourceFile[], solution: SourceFile[]): DiffFile[] {
  const sources = (files: SourceFile[]) =>
    new Map(
      files
        .filter((file) => !NOT_STUDENT_WORK.test(file.path))
        .map((file) => [file.path, file.content]),
    );
  const before = sources(template);
  const after = sources(solution);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((path): DiffFile[] => {
    const old = before.get(path);
    const next = after.get(path);
    if (old === next) {
      return [];
    }
    const patch = structuredPatch(path, path, old ?? "", next ?? "", "", "", { context: 3 });
    return [
      {
        path,
        change: old === undefined ? "added" : next === undefined ? "removed" : "modified",
        hunks: patch.hunks.map((hunk) => {
          let oldLine = hunk.oldStart;
          let newLine = hunk.newStart;
          return {
            header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            lines: hunk.lines
              .filter((line) => !line.startsWith("\\"))
              .map((line) => {
                const text = line.slice(1);
                if (line.startsWith("+")) {
                  return { kind: "added" as const, text, new: newLine++ };
                }
                if (line.startsWith("-")) {
                  return { kind: "removed" as const, text, old: oldLine++ };
                }
                return { kind: "context" as const, text, old: oldLine++, new: newLine++ };
              }),
          };
        }),
      },
    ];
  });
}

/** Lines a student writes: the non-blank lines the solution adds. */
export function addedLines(diff: DiffFile[]): number {
  return diff
    .flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))
    .filter((line) => line.kind === "added" && line.text.trim() !== "").length;
}
