import { cn } from "cn";
import { CircleDotIcon, Maximize2Icon } from "lucide-react";
import type { Root, RootContent, Text } from "mdast";
import {
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

import { CodeLines } from "./CodeLines.tsx";
import { languageOf } from "./highlight.ts";
import { renderDiagram } from "./plantuml.ts";

/** The markers the builder leaves where Artemis shows a task: `[task][Title]`, `[task:untested][Title]`. */
const TASK = /\[task(:untested)?]\[([^[\]]+)]/g;

/** Turn each task marker into an element the renderer shows as a task row, as Artemis does. */
function remarkTasks() {
  const visit = (node: Root | RootContent) => {
    if (!("children" in node)) {
      return;
    }
    node.children = node.children.flatMap((child): RootContent[] => {
      if (child.type !== "text" || !child.value.includes("[task")) {
        visit(child);
        return [child];
      }
      const parts: RootContent[] = [];
      let last = 0;
      for (const match of child.value.matchAll(TASK)) {
        const start = match.index ?? 0;
        if (start > last) {
          parts.push({ type: "text", value: child.value.slice(last, start) } satisfies Text);
        }
        parts.push({
          type: "text",
          value: match[2] ?? "",
          data: {
            hName: "span",
            hProperties: match[1] === undefined ? { dataTask: "" } : { dataTask: "untested" },
          },
        } satisfies Text);
        last = start + match[0].length;
      }
      if (last < child.value.length) {
        parts.push({ type: "text", value: child.value.slice(last) });
      }
      return parts;
    }) as typeof node.children;
  };
  return (tree: Root) => visit(tree);
}

/**
 * Artemis renders a statement's HTML, such as the `<br>` its templates use. The sanitizer keeps
 * GitHub's safe subset and the task rows above.
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), "dataTask"],
  },
};

/**
 * A task as Artemis shows it: a row of its own, with the task's text below it. A task that lists no
 * tests says so, since no submission could ever pass it.
 */
function TaskRow({ untested, children }: { untested: boolean; children: ReactNode }) {
  return (
    <span className="flex items-start gap-2">
      <CircleDotIcon aria-hidden="true" className="mt-1.5 size-4 shrink-0 text-muted-foreground" />
      <span>
        <span className="sr-only">Task: </span>
        <strong className="font-semibold">{children}</strong>
        {untested && <span className="ml-2 text-sm text-muted-foreground">No tests</span>}
      </span>
    </span>
  );
}

type Rendering =
  { state: "rendering" } | { state: "done"; svg: string } | { state: "failed"; error: string };

/**
 * A PlantUML diagram, rendered in the browser as Artemis renders it on its server. In a narrow
 * column it keeps its natural size and scrolls, opening at its centre, since scaled down its text
 * would be unreadable; from `@md` up it fits the column. Expanded, it fills the window on the same
 * page. If the engine cannot render it, the source shows instead, with the reason.
 */
function Diagram({ source, label }: { source: string; label: string }) {
  const [rendering, setRendering] = useState<Rendering>({ state: "rendering" });
  const frame = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    let current = true;
    renderDiagram(source).then(
      (svg) => current && setRendering({ state: "done", svg }),
      (error: unknown) =>
        current &&
        setRendering({
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      current = false;
    };
  }, [source]);
  const svg = rendering.state === "done" ? rendering.svg : null;
  const image = svg === null ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  useEffect(() => {
    const element = frame.current;
    if (element === null || svg === null) return;
    // PlantUML centres a diagram's root, so a diagram wider than its column opens at its centre.
    const centre = () => {
      const overflow = element.scrollWidth - element.clientWidth;
      setScrolls(overflow > 0);
      element.scrollLeft = overflow / 2;
    };
    const observer = new ResizeObserver(centre);
    observer.observe(element);
    return () => observer.disconnect();
  }, [svg]);
  if (rendering.state === "failed") {
    return (
      <figure className="my-4 flex flex-col gap-2">
        <figcaption className="text-sm text-muted-foreground">
          This diagram could not be drawn ({rendering.error}); its PlantUML source follows.
        </figcaption>
        <CodeBlock size="sm">
          <CodeBlockContent>{source}</CodeBlockContent>
        </CodeBlock>
      </figure>
    );
  }
  return (
    <figure className="my-4 flex flex-col items-start gap-1">
      {image === null ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        // The border frames the diagram; the fade inside it only marks that it scrolls.
        <div className="max-w-full rounded-md border bg-card">
          <div
            ref={frame}
            role="region"
            aria-label={label}
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a wide diagram must be keyboard-scrollable.
            tabIndex={0}
            className="scroll-fade-x scrollbar-thin overflow-x-auto p-2"
          >
            <img className="max-w-none @md:max-w-full" src={image} alt={label} />
          </div>
        </div>
      )}
      {image !== null && (
        <div className="flex flex-wrap items-center gap-x-3">
          <DiagramView image={image} label={label} />
          {scrolls && (
            <figcaption className="text-sm text-muted-foreground">
              Scroll sideways to see all of it.
            </figcaption>
          )}
        </div>
      )}
    </figure>
  );
}

/**
 * A diagram at full size on the same page: fitted to the window first, and at its actual size on
 * request, where it scrolls in both directions. Closing returns the focus to the button.
 */
function DiagramView({ image, label }: { image: string; label: string }) {
  const [actual, setActual] = useState(false);
  return (
    // On a phone, a diagram fitted to the screen is too small to read; it opens at actual size.
    <Dialog
      onOpenChange={(open) => open && setActual(window.matchMedia("(max-width: 767px)").matches)}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <Maximize2Icon aria-hidden="true" />
        Expand<span className="sr-only"> {label}</span>
      </DialogTrigger>
      <DialogContent className="h-11/12 w-full sm:max-w-7xl">
        <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
          <div className="flex items-center gap-3 pr-10">
            <DialogTitle>{label}</DialogTitle>
            <Button variant="outline" size="sm" onClick={() => setActual((value) => !value)}>
              {actual ? "Fit to window" : "Actual size"}
            </Button>
          </div>
          <div
            role="region"
            aria-label={`${label}, ${actual ? "actual size" : "fitted to the window"}`}
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- at actual size, a large diagram must be keyboard-scrollable.
            tabIndex={0}
            className={cn(
              "min-h-0 flex-1 scrollbar-thin rounded-md border bg-card p-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden",
            )}
          >
            <img
              className={actual ? "max-w-none" : "size-full object-contain"}
              src={image}
              alt={label}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The source lines where the document's diagrams start, so each gets a number in reading order. */
const DiagramLines = createContext<number[]>([]);

/** A fenced code block: a diagram for PlantUML, else code highlighted when it is Java or XML. */
function Fence({ children, line }: { children: ReactNode; line: number }) {
  const lines = useContext(DiagramLines);
  const code = isValidElement(children)
    ? (children as ReactElement<{ className?: string; children?: ReactNode }>)
    : null;
  const text = String(code?.props.children ?? "").replace(/\n$/, "");
  const language = /language-(\S+)/.exec(code?.props.className ?? "")?.[1] ?? "";
  if (language === "plantuml") {
    return <Diagram source={text} label={`Diagram ${lines.indexOf(line) + 1}`} />;
  }
  return (
    <div className="my-4">
      <CodeBlock size="sm">
        <CodeBlockContent>
          <CodeLines path={languageOf(language) ?? ""} code={text} />
        </CodeBlockContent>
      </CodeBlock>
    </div>
  );
}

function components(compact: boolean): Components {
  return {
    h1: ({ children }) => (
      <h2 className={cn("mt-0 mb-3 font-semibold", compact ? "text-base" : "text-lg")}>
        {children}
      </h2>
    ),
    h2: ({ children }) => <h3 className="mt-6 mb-2 text-base font-semibold">{children}</h3>,
    h3: ({ children }) => <h4 className="mt-5 mb-2 font-semibold">{children}</h4>,
    h4: ({ children }) => <h5 className="mt-4 mb-1 font-semibold">{children}</h5>,
    p: ({ children }) => <p className="my-3">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal pl-6">{children}</ol>,
    li: ({ children }) => <li className="my-1.5">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-4 pl-4 text-muted-foreground">{children}</blockquote>
    ),
    a: ({ children, href }) => (
      <a className="text-primary underline" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div
        role="region"
        aria-label="Table"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a wide table must be keyboard-scrollable.
        tabIndex={0}
        className="my-4 scroll-fade-x scrollbar-thin overflow-x-auto"
      >
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border bg-muted px-2 py-1 text-left font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
    pre: ({ children, node }) => <Fence line={node?.position?.start.line ?? 0}>{children}</Fence>,
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>
    ),
    img: ({ src, alt }) => (
      <img className="my-4 max-w-full rounded-md border" src={src} alt={alt ?? ""} />
    ),
    span: ({ children, ...props }) =>
      "data-task" in props ? (
        <TaskRow untested={props["data-task" as keyof typeof props] === "untested"}>
          {children}
        </TaskRow>
      ) : (
        <span>{children}</span>
      ),
  };
}

const PROSE = components(false);
const COMPACT = components(true);
/** A document that is a page of its own, such as a legal notice: its headings keep their levels. */
const PAGE: Components = {
  ...PROSE,
  h1: ({ children }) => (
    <h1 className="mt-0 mb-4 text-2xl font-semibold tracking-tight">{children}</h1>
  ),
  h2: ({ children }) => <h2 className="mt-8 mb-2 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-6 mb-2 text-base font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1 font-semibold">{children}</h4>,
};

/**
 * Markdown as the survey shows it: statements, briefs and instrument text. Prose keeps a readable
 * line length; `compact` fits it into the question pane. Inside a screen, a heading is one level
 * below the screen's own; `page` keeps the levels of a document that is the page itself.
 */
export function Markdown({
  children,
  compact = false,
  page = false,
}: {
  children: string;
  compact?: boolean;
  page?: boolean;
}) {
  const diagrams = children
    .split("\n")
    .flatMap((line, index) => (line.startsWith("```plantuml") ? [index + 1] : []));
  return (
    <DiagramLines.Provider value={diagrams}>
      <div
        className={cn(
          "@container max-w-prose text-foreground",
          compact ? "text-sm leading-6" : "text-base leading-7",
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkTasks]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
          components={page ? PAGE : compact ? COMPACT : PROSE}
        >
          {children}
        </ReactMarkdown>
      </div>
    </DiagramLines.Provider>
  );
}
