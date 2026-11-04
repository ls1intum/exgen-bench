import { structuredPatch } from "diff";

import { changedSources, type SourceFile } from "../../kit/changes.ts";
import type { DiffFile } from "../shared/exercise.ts";

export type { SourceFile };

/**
 * What a student has to add or change: the template-to-solution difference of each source file, in
 * hunks with three lines of context. The solution itself is never shown, only these hunks.
 */
export function templateDiff(template: SourceFile[], solution: SourceFile[]): DiffFile[] {
  return changedSources(template, solution).map(({ path, change, before, after }): DiffFile => {
    const patch = structuredPatch(path, path, before ?? "", after ?? "", "", "", { context: 3 });
    return {
      path,
      change,
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
    };
  });
}

/** Lines a student writes: the non-blank lines the solution adds. */
export function addedLines(diff: DiffFile[]): number {
  return diff
    .flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))
    .filter((line) => line.kind === "added" && line.text.trim() !== "").length;
}
