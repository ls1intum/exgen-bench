import { cn } from "cn";

/**
 * A file path as one line: the folder muted and shortened first, the file name always whole, and in
 * the link colour when the path is a link.
 */
export function PathLabel({ path, link = false }: { path: string; link?: boolean }) {
  const slash = path.lastIndexOf("/");
  return (
    <span title={path} className="flex min-w-0 items-baseline">
      {slash >= 0 && (
        <span className="min-w-0 truncate font-normal text-muted-foreground">
          {path.slice(0, slash + 1)}
        </span>
      )}
      <span className={cn("shrink-0 font-medium", link ? "text-primary" : "text-foreground")}>
        {path.slice(slash + 1)}
      </span>
    </span>
  );
}

/** A long folder chain shortened in the middle, as `src/de/…/exgen/exercise`. */
export function shortFolder(name: string): string {
  const segments = name.split("/");
  return segments.length <= 4
    ? name
    : [...segments.slice(0, 2), "…", ...segments.slice(-2)].join("/");
}
