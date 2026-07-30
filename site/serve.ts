import { relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? import.meta.dir);
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Malformed URL", { status: 400 });
    }
    const requested = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const path = resolve(root, `.${requested}`);
    const relativePath = relative(root, path);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": types[extension(path)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
});

process.stdout.write(`Evidence explorer: http://localhost:${port}\n`);
