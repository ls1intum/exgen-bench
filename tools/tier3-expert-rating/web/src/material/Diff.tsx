import { cn } from "cn";

import { Badge } from "@/components/ui/badge";

import type { ExerciseView } from "../../../shared/exercise.ts";

type Files = NonNullable<ExerciseView["diff"]>;

/** What the student adds or changes, file by file, as unified hunks. */
export function Diff({ files }: { files: Files }) {
  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">The solution changes no file.</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      {files.map((file) => (
        <section
          key={file.path}
          aria-label={file.path}
          className="overflow-hidden rounded-md border"
        >
          <header className="flex items-center gap-2 border-b bg-muted px-3 py-2">
            <span className="font-mono text-xs break-all">{file.path}</span>
            <Badge variant="outline">{file.change}</Badge>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs leading-5">
              {file.hunks.map((hunk) => (
                <tbody key={hunk.header}>
                  <tr>
                    <td colSpan={3} className="bg-muted/60 px-3 py-0.5 text-muted-foreground">
                      {hunk.header}
                    </td>
                  </tr>
                  {hunk.lines.map((line) => (
                    <tr
                      key={`${line.old ?? ""}:${line.new ?? ""}`}
                      className={cn(
                        line.kind === "added" && "bg-code-added",
                        line.kind === "removed" && "bg-code-removed",
                      )}
                    >
                      <td className="w-12 px-2 text-right text-muted-foreground select-none">
                        {line.old}
                      </td>
                      <td className="w-12 px-2 text-right text-muted-foreground select-none">
                        {line.new}
                      </td>
                      <td className="px-2 whitespace-pre">
                        <span aria-hidden="true" className="select-none">
                          {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                        </span>
                        <span className="sr-only">
                          {line.kind === "added"
                            ? "Added: "
                            : line.kind === "removed"
                              ? "Removed: "
                              : ""}
                        </span>
                        {line.text}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
