import { lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { buildStaticSite } from "./build.ts";

const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

async function containsSymlink(root: string, path: string): Promise<boolean> {
  let current = root;
  try {
    if ((await lstat(root)).isSymbolicLink()) return true;
    for (const component of relative(root, path).split(sep).filter(Boolean)) {
      current = join(current, component);
      if ((await lstat(current)).isSymbolicLink()) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function serveSite(rootInput = import.meta.dir, port = 4173) {
  const root = resolve(rootInput);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return Bun.serve({
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
      if (await containsSymlink(root, path)) {
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
}

if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? "4173", 10);
  const root =
    process.argv[2] ??
    (await buildStaticSite({
      outputDirectory: resolve(import.meta.dirname, "dist"),
      includeDemoData: true,
    }));
  serveSite(root, port);
  process.stdout.write(`Results dashboard: http://localhost:${port}\n`);
}
