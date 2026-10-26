import { cn } from "cn";
import { CircleDotIcon, Maximize2Icon } from "lucide-react";
import type { Root, RootContent, Text } from "mdast";
import {
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { buttonVariants } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";

import { CodeLines } from "./CodeLines.tsx";
import { languageOf } from "./highlight.ts";

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
 * GitHub's safe subset, the task rows above, and the study server's diagram links.
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), "dataTask"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "diagram"],
  },
};

/** Pre-rendered diagrams are served by the study server, and only while their part is open. */
function urlTransform(url: string): string {
  const diagram = /^diagram:(\d+)$/.exec(url);
  return diagram === null ? defaultUrlTransform(url) : `/api/diagram/${diagram[1]}`;
}

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

/**
 * A rendered diagram. In a narrow column it keeps its natural size and scrolls, since scaled down its
 * text would be unreadable; from `@md` up it fits the column. Its own tab shows it with zoom.
 */
function Diagram({ src, alt }: { src: string; alt: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    // PlantUML centres a diagram's root, so a diagram wider than its column opens at its centre.
    const centre = () => {
      const overflow = element.scrollWidth - element.clientWidth;
      setScrolls(overflow > 0);
      element.scrollLeft = overflow / 2;
    };
    const observer = new ResizeObserver(centre);
    observer.observe(element);
    element.querySelector("img")?.addEventListener("load", centre);
    return () => observer.disconnect();
  }, []);
  return (
    <figure className="my-4 flex flex-col items-start gap-1">
      {/* The border frames the diagram; the fade inside it only marks that it scrolls. */}
      <div className="max-w-full rounded-md border bg-card">
        <div
          ref={frame}
          role="region"
          aria-label={alt}
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a wide diagram must be keyboard-scrollable.
          tabIndex={0}
          className="scroll-fade-x scrollbar-thin overflow-x-auto p-2"
        >
          <img className="max-w-none @md:max-w-full" src={src} alt={alt} />
        </div>
      </div>
      <figcaption className="text-sm text-muted-foreground">
        Diagram as students see it in Artemis{scrolls && "; scroll sideways to see all of it"}
      </figcaption>
      <a
        className={buttonVariants({ variant: "ghost", size: "sm" })}
        href={src}
        target="_blank"
        rel="noreferrer"
      >
        <Maximize2Icon aria-hidden="true" />
        Open full size
      </a>
    </figure>
  );
}

/** A fenced code block, highlighted when its language is Java or XML. */
function Fence({ children }: { children: ReactNode }) {
  const code = isValidElement(children)
    ? (children as ReactElement<{ className?: string; children?: ReactNode }>)
    : null;
  const text = String(code?.props.children ?? "").replace(/\n$/, "");
  const language = /language-(\S+)/.exec(code?.props.className ?? "")?.[1] ?? "";
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
    pre: ({ children }) => <Fence>{children}</Fence>,
    code: ({ children }) => (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>
    ),
    img: ({ src, alt }) =>
      typeof src === "string" && src.startsWith("/api/diagram/") ? (
        <Diagram src={src} alt={alt ?? "Diagram"} />
      ) : (
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

/**
 * Markdown as the survey shows it: statements, briefs and instrument text. Prose keeps a readable
 * line length; `compact` fits it into the question pane.
 */
export function Markdown({ children, compact = false }: { children: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "@container max-w-prose text-foreground",
        compact ? "text-sm leading-6" : "text-base leading-7",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkTasks]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={compact ? COMPACT : PROSE}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
