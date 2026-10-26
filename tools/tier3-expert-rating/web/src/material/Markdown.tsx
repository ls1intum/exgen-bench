import { ListChecksIcon } from "lucide-react";
import type { Root, RootContent, Text } from "mdast";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/** The marker the server leaves where Artemis shows a task: `[task][Title]`. */
const TASK = /\[task]\[([^[\]]+)]/g;

/** Turn each task marker into an element the renderer shows as a task heading, as Artemis does. */
function remarkTasks() {
  const visit = (node: Root | RootContent) => {
    if (!("children" in node)) {
      return;
    }
    node.children = node.children.flatMap((child): RootContent[] => {
      if (child.type !== "text" || !child.value.includes("[task][")) {
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
          value: match[1] ?? "",
          data: { hName: "span", hProperties: { dataTask: "" } },
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

/** Pre-rendered diagrams are served by the study server, and only while their part is open. */
function urlTransform(url: string): string {
  const diagram = /^diagram:(\d+)$/.exec(url);
  return diagram === null ? defaultUrlTransform(url) : `/api/diagram/${diagram[1]}`;
}

const components: Components = {
  h1: ({ children }) => <h2 className="mt-0 mb-3 text-xl font-semibold">{children}</h2>,
  h2: ({ children }) => <h3 className="mt-6 mb-2 text-lg font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-5 mb-2 text-base font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-4 mb-1 text-sm font-semibold">{children}</h5>,
  p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-1 leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-4 pl-4 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ children, href }) => (
    <a className="text-primary underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border bg-muted px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="font-mono text-sm">{children}</code>,
  img: ({ src, alt }) => (
    <img className="my-4 max-w-full rounded-md border bg-card p-2" src={src} alt={alt ?? ""} />
  ),
  span: ({ children, ...props }) =>
    "data-task" in props ? (
      <span className="mr-1 inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-medium">
        <ListChecksIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="sr-only">Task: </span>
        {children}
      </span>
    ) : (
      <span>{children}</span>
    ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkTasks]}
        components={components}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
