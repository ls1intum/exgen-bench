import { cn } from "cn";
import type { ReactNode } from "react";

import type { Session } from "../../shared/api.ts";

type RaterSession = Extract<Session, { kind: "rater" }>;

/** Header and page frame of every rater screen. Rating screens use the full width. */
export function Shell({
  session,
  wide,
  children,
}: {
  session: RaterSession;
  wide: boolean;
  children: ReactNode;
}) {
  const current = session.progress.find((segment) => segment.state === "current");
  return (
    <div className={cn("flex flex-col bg-background", wide ? "h-screen" : "min-h-screen")}>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-6 py-3">
        <p className="m-0 font-semibold">
          Expert study
          <span className="ml-2 font-normal text-muted-foreground">{session.study.title}</span>
        </p>
        <nav aria-label="Progress" className="ml-auto flex items-center gap-3">
          <ol className="m-0 flex list-none gap-1 p-0">
            {session.progress.map((segment) => (
              <li
                key={segment.label}
                title={segment.label}
                aria-current={segment.state === "current" ? "step" : undefined}
                className={cn(
                  "h-1.5 w-6 rounded-full",
                  segment.state === "done" && "bg-primary/50",
                  segment.state === "current" && "bg-primary",
                  segment.state === "todo" && "bg-border",
                )}
              >
                <span className="sr-only">
                  {segment.label}: {segment.state === "todo" ? "to do" : segment.state}
                </span>
              </li>
            ))}
          </ol>
          {current !== undefined && (
            <span className="text-xs text-muted-foreground">{current.label}</span>
          )}
        </nav>
      </header>
      <main
        id="main-content"
        className={cn(
          "flex w-full flex-1 flex-col",
          wide ? "min-h-0" : "mx-auto max-w-3xl px-6 py-10",
        )}
      >
        {children}
      </main>
    </div>
  );
}
