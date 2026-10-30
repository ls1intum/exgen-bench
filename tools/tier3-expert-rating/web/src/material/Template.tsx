import { cn } from "cn";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  WrapTextIcon,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

import type { ExerciseView } from "../../../shared/exercise.ts";
import { CodeLines } from "./CodeLines.tsx";
import { PathLabel, shortFolder } from "./PathLabel.tsx";

type Files = NonNullable<ExerciseView["template"]>;

type TreeNode =
  | { kind: "folder"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

/** Configuration files and folders whose names start with a dot; Artemis hides them as well. */
const isHidden = (path: string) => path.split("/").some((segment) => segment.startsWith("."));

/**
 * The files as a tree: folders before files, each alphabetically, and a chain of folders that
 * holds nothing but the next folder shown as one row, as Java packages are (`src/de/tum/…`).
 */
export function fileTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const path of paths) {
    const segments = path.split("/");
    let level = root;
    segments.forEach((name, index) => {
      const nodePath = segments.slice(0, index + 1).join("/");
      if (index === segments.length - 1) {
        level.push({ kind: "file", name, path: nodePath });
        return;
      }
      let folder = level.find(
        (node): node is Extract<TreeNode, { kind: "folder" }> =>
          node.kind === "folder" && node.name === name,
      );
      if (folder === undefined) {
        folder = { kind: "folder", name, path: nodePath, children: [] };
        level.push(folder);
      }
      level = folder.children;
    });
  }
  const tidy = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .map((node) => {
        if (node.kind === "file") return node;
        let folder = node;
        while (folder.children.length === 1 && folder.children[0]?.kind === "folder") {
          const only = folder.children[0];
          folder = { ...only, name: `${folder.name}/${only.name}` };
        }
        return { ...folder, children: tidy(folder.children) };
      })
      .sort((left, right) =>
        left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === "folder"
            ? -1
            : 1,
      );
  return tidy(root);
}

/** The file a student would open first: one the solution changes, else a Java stub. */
function initialFile(files: Files, changed: ReadonlySet<string>): string | undefined {
  const java = files.filter((file) => file.path.endsWith(".java"));
  return (
    java.find((file) => changed.has(file.path))?.path ??
    java.find((file) => /TODO|not implemented/i.test(file.content))?.path ??
    java[0]?.path ??
    files[0]?.path
  );
}

const row = "w-full justify-start font-normal";

/** Whether an element is narrower than Tailwind's `@2xl` container width (42rem). */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const observer = new ResizeObserver(([entry]) => {
      setNarrow((entry?.contentRect.width ?? 0) < 42 * rem);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

interface TreeProps {
  nodes: TreeNode[];
  selected: string | undefined;
  changed: ReadonlySet<string>;
  onSelect: (path: string) => void;
}

function Folder({
  node,
  ...props
}: Omit<TreeProps, "nodes"> & { node: Extract<TreeNode, { kind: "folder" }> }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        title={node.path}
        onClick={() => setOpen((value) => !value)}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), row)}
      >
        {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        {open ? <FolderOpenIcon aria-hidden="true" /> : <FolderIcon aria-hidden="true" />}
        <span className="min-w-0 truncate">{shortFolder(node.name)}</span>
      </button>
      {open && (
        <div className="pl-4">
          <Tree {...props} nodes={node.children} />
        </div>
      )}
    </>
  );
}

function Tree({ nodes, selected, changed, onSelect }: TreeProps) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === "folder" ? (
            <Folder node={node} selected={selected} changed={changed} onSelect={onSelect} />
          ) : (
            <button
              type="button"
              title={node.path}
              aria-current={node.path === selected ? "true" : undefined}
              onClick={() => onSelect(node.path)}
              className={cn(
                buttonVariants({
                  variant: node.path === selected ? "secondary" : "ghost",
                  size: "sm",
                }),
                row,
              )}
            >
              <FileIcon aria-hidden="true" />
              <span className="min-w-0 truncate">{node.name}</span>
              {changed.has(node.path) && (
                <span className="ml-auto pl-2 font-mono text-xs text-muted-foreground">
                  <span aria-hidden="true" title="Students change this file">
                    M
                  </span>
                  <span className="sr-only">, students change this file</span>
                </span>
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The template repository: a file tree next to the selected file, like a repository on GitHub or
 * Artemis' online editor. In a narrow pane, the tree folds away above the file.
 */
export function Template({
  files,
  onOpen,
  changed = [],
}: {
  files: Files;
  onOpen: (path: string) => void;
  /** Template files the sample solution changes. */
  changed?: readonly string[];
}) {
  const changes = new Set(changed);
  const [selected, setSelected] = useState(() => initialFile(files, changes));
  const [showHidden, setShowHidden] = useState(false);
  // Wrapped in a narrow pane, where little of a line would show; scrolled in a wide one.
  const container = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(container);
  const [chosenWrap, setWrap] = useState<boolean | null>(null);
  const wrap = chosenWrap ?? narrow;
  const [treeOpen, setTreeOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (files.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>The template has no files</EmptyTitle>
          <EmptyDescription>Students start from an empty repository.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const hidden = files.filter((file) => isHidden(file.path));
  const shown = showHidden ? files : files.filter((file) => !isHidden(file.path));
  const tree = fileTree(shown.map((file) => file.path));
  const file = files.find((candidate) => candidate.path === selected);
  const select = (path: string) => {
    setSelected(path);
    onOpen(path);
    if (narrow) {
      // The folded tree closes on a choice; focus returns to its trigger instead of the page.
      setTreeOpen(false);
      requestAnimationFrame(() => trigger.current?.focus());
    }
  };
  const navigation = (
    <nav aria-label="Template files" className="flex flex-col gap-2">
      <Tree nodes={tree} selected={selected} changed={changes} onSelect={select} />
      <div className="flex flex-col items-start gap-1 border-t pt-2 text-xs text-muted-foreground">
        {changes.size > 0 && (
          <p className="m-0 px-2">
            <span aria-hidden="true" className="font-mono">
              M
            </span>{" "}
            = students change this file
          </p>
        )}
        {hidden.length > 0 && (
          <Button variant="link" size="sm" onClick={() => setShowHidden((value) => !value)}>
            {showHidden
              ? `Hide ${hidden.length} configuration ${hidden.length === 1 ? "file" : "files"}`
              : `Show ${hidden.length} hidden configuration ${hidden.length === 1 ? "file" : "files"}`}
          </Button>
        )}
      </div>
    </nav>
  );
  return (
    <div ref={container} className="@container">
      <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-start">
        <div className="hidden @2xl:sticky @2xl:top-0 @2xl:block @2xl:w-64 @2xl:shrink-0">
          {navigation}
        </div>
        <div className="@2xl:hidden">
          <Collapsible open={treeOpen} onOpenChange={setTreeOpen}>
            <CollapsibleTrigger ref={trigger} render={<Button variant="outline" size="sm" />}>
              {treeOpen ? (
                <ChevronDownIcon aria-hidden="true" />
              ) : (
                <ChevronRightIcon aria-hidden="true" />
              )}
              Files ({shown.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-lg border p-2">{navigation}</div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <section aria-label={file?.path ?? "No file"} className="min-w-0 flex-1">
          {file !== undefined && (
            <CodeBlock size="sm">
              <CodeBlockHeader>
                <CodeBlockTitle>
                  <PathLabel path={file.path} />
                </CodeBlockTitle>
                <CodeBlockActions>
                  <Button
                    variant={wrap ? "secondary" : "ghost"}
                    size="icon-xs"
                    aria-pressed={wrap}
                    aria-label="Wrap long lines"
                    title="Wrap long lines"
                    onClick={() => setWrap(!wrap)}
                  >
                    <WrapTextIcon />
                  </Button>
                  <CodeBlockCopyButton value={file.content} />
                </CodeBlockActions>
              </CodeBlockHeader>
              <CodeBlockContent lineNumbers wrap={wrap}>
                <CodeLines path={file.path} code={file.content} />
              </CodeBlockContent>
            </CodeBlock>
          )}
        </section>
      </div>
    </div>
  );
}
