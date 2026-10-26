import { cn } from "cn";
import { FileIcon } from "lucide-react";
import { useState } from "react";

import type { ExerciseView } from "../../../shared/exercise.ts";
import { useHighlightedLines } from "./highlight.ts";

type Files = NonNullable<ExerciseView["template"]>;

/** The file a student would open first: one with work to do, else the first Java source. */
function initialFile(files: Files): string | undefined {
  return (
    files.find((file) => file.path.endsWith(".java") && /TODO|not implemented/i.test(file.content))
      ?.path ??
    files.find((file) => file.path.endsWith(".java"))?.path ??
    files[0]?.path
  );
}

export function CodeBlock({ path, code }: { path: string; code: string }) {
  const lines = useHighlightedLines(path, code);
  return (
    <pre className="m-0 overflow-x-auto py-2 font-mono text-xs leading-5">
      <code>
        {lines.map((tokens, index) => (
          // Lines of an immutable file: the index is the line's identity.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} className="flex">
            <span
              aria-hidden="true"
              className="w-12 shrink-0 pr-4 text-right text-muted-foreground select-none"
            >
              {index + 1}
            </span>
            <span className="whitespace-pre">
              {tokens.map((token, position) => (
                // oxlint-disable-next-line react/no-array-index-key
                <span key={position} className={token.className}>
                  {token.text}
                </span>
              ))}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}

/** A file's folder, with its trailing slash; empty for a file at the repository root. */
function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/**
 * The template repository: its files on the left, grouped by folder so deep Java packages stay
 * readable, and the selected file on the right.
 */
export function Template({ files, onOpen }: { files: Files; onOpen: (path: string) => void }) {
  const [selected, setSelected] = useState(() => initialFile(files));
  const file = files.find((candidate) => candidate.path === selected);
  const folders = [...Map.groupBy(files, (candidate) => folderOf(candidate.path))].sort(
    ([left], [right]) => (left === "" ? -1 : right === "" ? 1 : left.localeCompare(right)),
  );
  return (
    <div className="grid min-h-0 grid-cols-4 gap-4">
      <nav aria-label="Template files" className="col-span-1 flex min-w-0 flex-col gap-3">
        {folders.map(([folder, contents]) => (
          <div key={folder} className="flex flex-col gap-0.5">
            {folder !== "" && (
              <p className="m-0 px-2 font-mono text-xs break-all text-muted-foreground">{folder}</p>
            )}
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {contents.map((candidate) => (
                <li key={candidate.path}>
                  <button
                    type="button"
                    aria-current={candidate.path === selected ? "true" : undefined}
                    aria-label={candidate.path}
                    onClick={() => {
                      setSelected(candidate.path);
                      onOpen(candidate.path);
                    }}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs break-all",
                      candidate.path === selected ? "bg-muted font-medium" : "hover:bg-muted/60",
                    )}
                  >
                    <FileIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    {candidate.path.slice(folder.length)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <section
        aria-label={file?.path ?? "No file"}
        className="col-span-3 min-w-0 rounded-md border"
      >
        {file === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">The template has no files.</p>
        ) : (
          <>
            <p className="m-0 border-b px-3 py-2 font-mono text-xs text-muted-foreground">
              {file.path}
            </p>
            <CodeBlock path={file.path} code={file.content} />
          </>
        )}
      </section>
    </div>
  );
}
