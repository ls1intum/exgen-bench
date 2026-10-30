import { cn } from "cn";
import { type ReactNode, useEffect } from "react";

import type { ProgressSegment } from "../../shared/api.ts";
import { Footer } from "./Legal.tsx";
import { positionOf } from "./progress.ts";
import type { RaterSession } from "./step.ts";

const FILL: Record<ProgressSegment["state"], string> = {
  done: "bg-primary",
  current: "bg-primary/35",
  todo: "bg-border",
};

/**
 * The study as a row of segments. The exercise being rated is split into its four parts, so the
 * tracker moves with every part the rater submits.
 */
function Tracker({ session, rating }: { session: RaterSession; rating: boolean }) {
  const { partsDone } = positionOf(session);
  const parts = session.instrument.questionnaire.parts;
  return (
    <ol
      className={cn(
        "m-0 flex w-full list-none items-center gap-1 p-0",
        rating ? "lg:w-auto" : "sm:w-auto",
      )}
    >
      {session.progress.map((segment) => {
        const split = segment.state === "current" && partsDone !== null;
        return (
          <li
            key={segment.label}
            aria-current={segment.state === "current" ? "step" : undefined}
            className={cn(
              "flex h-1.5 gap-px overflow-hidden rounded-full",
              rating ? "lg:flex-none" : "sm:flex-none",
              split ? "grow-2" : "flex-1",
              split && (rating ? "lg:w-12" : "sm:w-12"),
              !split && (rating ? "lg:w-6" : "sm:w-6"),
            )}
          >
            {split ? (
              parts.map((part, index) => (
                <span
                  key={part.id}
                  className={cn(
                    "h-full flex-1",
                    FILL[index < partsDone ? "done" : index === partsDone ? "current" : "todo"],
                  )}
                />
              ))
            ) : (
              <span className={cn("h-full flex-1", FILL[segment.state])} />
            )}
            <span className="sr-only">
              {segment.label}: {segment.state === "todo" ? "to do" : segment.state}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Header and page frame of every rater screen, with one document scroll. */
export function Shell({
  session,
  wide,
  children,
}: {
  session: RaterSession;
  wide: boolean;
  children: ReactNode;
}) {
  const { label, short, minutesLeft } = positionOf(session);
  const { title } = session.study;
  // The tab names the step, so that every step reads as a page of its own.
  useEffect(() => {
    document.title = label === "" ? title : `${label} · ${title}`;
  }, [label, title]);
  // While rating below lg, the header is one line and the tracker: the material needs the height.
  const rating = session.step.kind === "part";
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b">
        <div
          className={cn(
            "flex flex-col gap-2 px-4 py-3 sm:px-6",
            rating
              ? "lg:flex-row lg:items-center lg:gap-6"
              : "sm:flex-row sm:items-center sm:gap-6",
          )}
        >
          <p
            className={cn(
              "m-0 min-w-0 text-sm font-semibold lg:truncate",
              rating ? "hidden lg:block lg:flex-1" : "sm:flex-1",
            )}
          >
            {title}
          </p>
          <nav
            aria-label="Progress"
            className={cn(
              "flex flex-col gap-2",
              rating
                ? "lg:shrink-0 lg:flex-row lg:items-center lg:gap-3"
                : "sm:shrink-0 sm:flex-row sm:items-center sm:gap-3",
            )}
          >
            {label !== "" &&
              (rating ? (
                <p className="m-0 text-sm lg:whitespace-nowrap">
                  <span className="font-medium">
                    <span className="lg:hidden">{short}</span>
                    <span className="hidden lg:inline">{label}</span>
                  </span>
                  {minutesLeft !== null && (
                    <span className="text-muted-foreground">
                      {" "}
                      · <span className="hidden lg:inline">about </span>
                      {minutesLeft} min left
                    </span>
                  )}
                </p>
              ) : (
                <p className="m-0 flex flex-wrap gap-x-1 text-sm sm:flex-nowrap sm:whitespace-nowrap">
                  <span className="font-medium">{label}</span>
                  {minutesLeft !== null && (
                    <span className="basis-full text-muted-foreground sm:basis-auto">
                      <span className="hidden sm:inline">· </span>about {minutesLeft} min left
                    </span>
                  )}
                </p>
              ))}
            <Tracker session={session} rating={rating} />
          </nav>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          "flex w-full flex-1 flex-col outline-none",
          wide ? "min-w-0" : "mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12",
        )}
      >
        {children}
      </main>
      <Footer />
    </div>
  );
}
