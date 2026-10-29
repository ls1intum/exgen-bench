import { cn } from "cn";
import { ChevronDownIcon, ChevronRightIcon, WrapTextIcon } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

import type { DiffFile } from "../../../shared/exercise.ts";
import { useHighlightedLines } from "./highlight.ts";
import { PathLabel } from "./PathLabel.tsx";

type Hunk = DiffFile["hunks"][number];

const lines = (count: number) => `${count} unchanged ${count === 1 ? "line" : "lines"}`;

function stats(file: DiffFile) {
  const all = file.hunks.flatMap((hunk) => hunk.lines);
  return {
    added: all.filter((line) => line.kind === "added").length,
    removed: all.filter((line) => line.kind === "removed").length,
  };
}

/** Added and removed lines, in words for screen readers and as GitHub's +N −M for everyone else. */
function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
      <span aria-hidden="true" className="text-code-string">
        +{added}
      </span>
      <span aria-hidden="true" className="text-destructive">
        −{removed}
      </span>
      <span className="sr-only">
        {added} lines added, {removed} lines removed
      </span>
    </span>
  );
}

/** Lines of the template between two hunks that the solution keeps as they are. */
function Gap({ count }: { count: number }) {
  return (
    <tr>
      <td colSpan={4} className="bg-muted/60 px-3 py-1 text-muted-foreground">
        ⋯ {lines(count)}
      </td>
    </tr>
  );
}

function HunkRows({ path, hunk, wrap }: { path: string; hunk: Hunk; wrap: boolean }) {
  // One hunk highlighted as a whole keeps a multi-line comment or string highlighted throughout.
  const tokens = useHighlightedLines(path, hunk.lines.map((line) => line.text).join("\n"));
  return hunk.lines.map((line, index) => (
    <tr
      key={`${line.old ?? ""}:${line.new ?? ""}`}
      className={cn(
        line.kind === "added" && "bg-code-added",
        line.kind === "removed" && "bg-code-removed",
      )}
    >
      <td className="w-10 px-2 text-right align-top text-muted-foreground select-none">
        {line.old}
      </td>
      <td className="w-10 px-2 text-right align-top text-muted-foreground select-none">
        {line.new}
      </td>
      <td className="w-4 pl-1 align-top select-none">
        <span aria-hidden="true">
          {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
        </span>
        <span className="sr-only">
          {line.kind === "added" ? "Added:" : line.kind === "removed" ? "Removed:" : ""}
        </span>
      </td>
      <td className={cn("pr-3", wrap ? "wrap-break-word whitespace-pre-wrap" : "whitespace-pre")}>
        {(tokens[index] ?? [{ text: line.text, className: undefined }]).map((token, position) =>
          token.className === undefined ? (
            token.text
          ) : (
            // oxlint-disable-next-line react/no-array-index-key
            <span key={position} className={token.className}>
              {token.text}
            </span>
          ),
        )}
      </td>
    </tr>
  ));
}

const firstOld = (hunk: Hunk) => hunk.lines.find((line) => line.old !== undefined)?.old;
const lastOld = (hunk: Hunk) => hunk.lines.findLast((line) => line.old !== undefined)?.old;

function FileChanges({
  file,
  id,
  wrap,
  onWrap,
  open,
  onOpenChange,
}: {
  file: DiffFile;
  id: string;
  wrap: boolean;
  onWrap: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { added, removed } = stats(file);
  return (
    <section
      id={id}
      aria-label={file.path}
      className="scroll-mt-16 overflow-hidden rounded-lg border"
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
          {/* A one-column grid lets the trigger shrink, so the path truncates before the counts. */}
          <div className="grid min-w-0 flex-1 grid-cols-1">
            <CollapsibleTrigger>
              <span className="flex w-full min-w-0 items-center gap-2 text-left text-xs">
                {open ? (
                  <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0" />
                )}
                <PathLabel path={file.path} />
              </span>
            </CollapsibleTrigger>
          </div>
          {file.change === "added" && <Badge variant="secondary">New file</Badge>}
          {file.change === "removed" && <Badge variant="destructive">Deleted</Badge>}
          <Stat added={added} removed={removed} />
          <Button
            variant={wrap ? "secondary" : "ghost"}
            size="icon-xs"
            aria-pressed={wrap}
            aria-label="Wrap long lines"
            title="Wrap long lines"
            onClick={onWrap}
          >
            <WrapTextIcon />
          </Button>
        </div>
        <CollapsibleContent>
          <div
            role="region"
            aria-label={`Changes in ${file.path}`}
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- overflowing code must be keyboard-scrollable.
            tabIndex={0}
            className="scroll-fade-x scrollbar-thin overflow-x-auto"
          >
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <thead className="sr-only">
                <tr>
                  <th scope="col">Template line</th>
                  <th scope="col">Solution line</th>
                  <th scope="col">Change</th>
                  <th scope="col">Code</th>
                </tr>
              </thead>
              {file.hunks.map((hunk, index) => {
                const previous = index === 0 ? 0 : (lastOld(file.hunks[index - 1] as Hunk) ?? 0);
                const start = firstOld(hunk);
                const skipped = start === undefined ? 0 : start - previous - 1;
                return (
                  <tbody key={hunk.header}>
                    {skipped > 0 && <Gap count={skipped} />}
                    <HunkRows path={file.path} hunk={hunk} wrap={wrap} />
                  </tbody>
                );
              })}
            </table>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * What a student adds or changes, file by file, as GitHub shows a pull request: unified lines with
 * template and solution line numbers, + and − markers, and the unchanged lines between changes folded.
 */
export function Diff({ files }: { files: DiffFile[] }) {
  const base = useId();
  // Diffs are short and their comments often say what to do, so lines wrap unless asked not to.
  const [wrap, setWrap] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string, open: boolean) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
  if (files.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>The solution changes no file</EmptyTitle>
          <EmptyDescription>The template already is the sample solution.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const total = files
    .map(stats)
    .reduce(
      (sum, stat) => ({ added: sum.added + stat.added, removed: sum.removed + stat.removed }),
      { added: 0, removed: 0 },
    );
  const anchor = (index: number) => `${base}-file-${index}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <Stat {...total} />
        <span className="text-xs text-muted-foreground">
          <span aria-hidden="true">−</span> template line · <span aria-hidden="true">+</span>{" "}
          solution line
        </span>
      </div>
      {files.length > 1 && (
        <nav aria-label="Changed files">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {files.map((file, index) => (
              <li key={file.path} className="flex items-center gap-2">
                <a
                  className="flex min-h-6 min-w-0 items-center text-xs hover:underline"
                  href={`#${anchor(index)}`}
                  onClick={() => toggle(file.path, true)}
                >
                  <PathLabel path={file.path} link />
                </a>
                <Stat {...stats(file)} />
              </li>
            ))}
          </ul>
        </nav>
      )}
      {files.map((file, index) => (
        <FileChanges
          key={file.path}
          file={file}
          id={anchor(index)}
          wrap={wrap}
          onWrap={() => setWrap((value) => !value)}
          open={!collapsed.has(file.path)}
          onOpenChange={(next) => toggle(file.path, next)}
        />
      ))}
    </div>
  );
}
