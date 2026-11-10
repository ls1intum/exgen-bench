import { cn } from "cn";
import { ArrowLeftIcon, ArrowRightIcon, EyeIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

import type { PreviewEntry, PreviewExercise, PreviewList } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { Inline } from "../items/ItemField.tsx";
import { Footer } from "../Legal.tsx";
import { MATERIAL_CAPTION, MATERIAL_LABEL } from "../material/captions.ts";
import { MaterialContent } from "../material/MaterialContent.tsx";
import { phaseLabel } from "../material/phase.ts";

type Load<T> =
  { state: "loading" } | { state: "ready"; value: T } | { state: "error"; error: ApiError };

const PREVIEW_PATH = "/preview";

function hrefOf(code: string): string {
  return `${PREVIEW_PATH}/${encodeURIComponent(code)}`;
}

/** The exercise the address names, such as E1 in /preview/E1; none for /preview itself. */
function codeOfPath(): string | null {
  const code = /^\/preview\/([^/]+)\/?$/.exec(window.location.pathname)?.[1];
  if (code === undefined) return null;
  try {
    return decodeURIComponent(code);
  } catch {
    return code;
  }
}

function failure(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, "The server cannot be reached.");
}

const linkClass =
  "rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** A plain left click follows the link inside the page; any other opens it as the browser would. */
function inPage(event: MouseEvent, go: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  go();
}

function entryLabel(entry: PreviewEntry): string {
  return entry.title === null ? entry.code : `${entry.code} · ${entry.title}`;
}

function ErrorMessage({ error }: { error: ApiError }) {
  if (error.status === 401) {
    return (
      <div className="flex max-w-prose flex-col gap-2">
        <h1 className="m-0 text-xl font-semibold">Open the study team's link</h1>
        <p className="m-0 text-muted-foreground">
          The preview of the frozen exercises is for the study team. Open the study team's link
          first, then come back to this page; or preview a built study before deploying it with{" "}
          <code>exgen survey preview</code>.
        </p>
      </div>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>The preview cannot be loaded</AlertTitle>
      <AlertDescription>{`${error.message} Reload the page to try again.`}</AlertDescription>
    </Alert>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

/** What raters never see: which exercise this is in the study, and where it came from. */
function StudyTeamHeader({
  preview,
  heading,
}: {
  preview: PreviewExercise;
  heading: (element: HTMLHeadingElement | null) => void;
}) {
  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-3">
      <h1
        id="preview-heading"
        ref={heading}
        tabIndex={-1}
        className="m-0 text-xl font-semibold outline-none"
      >
        {entryLabel(preview)}
      </h1>
      <dl className="m-0 flex flex-wrap gap-x-8 gap-y-1 text-sm">
        <Fact label="Code">
          <span className="font-mono">{preview.code}</span>
        </Fact>
        <Fact label="Phase">{phaseLabel(preview.phase)}</Fact>
        <Fact label="Frozen ID">
          <span className="font-mono">{preview.id}</span>
        </Fact>
        <Fact label="Source case">
          {preview.case === null ? (
            <span className="text-muted-foreground">Not recorded</span>
          ) : (
            <span className="font-mono break-all">{preview.case}</span>
          )}
        </Fact>
        <Fact label="SHA-256">
          <span className="font-mono text-xs break-all">{preview.sha256}</span>
        </Fact>
      </dl>
      <p className="m-0 text-xs text-muted-foreground">
        Only the study team sees this header. Raters see the random ID and the phase below.
      </p>
    </section>
  );
}

/** The material raters see, every part's at once, under the part that first shows it. */
function RatersView({ preview, parts }: { preview: PreviewExercise; parts: PreviewList["parts"] }) {
  const { exercise } = preview;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2 rounded-lg border px-4 py-2">
        <span className="sr-only">Raters see the exercise as</span>
        <span className="font-mono text-sm font-semibold">{exercise.id}</span>
        <Badge variant="secondary">{phaseLabel(exercise.phase)}</Badge>
      </div>
      {parts.map((part) => (
        <section
          key={part.id}
          aria-labelledby={`part-${part.id}`}
          className="flex flex-col gap-4 border-t pt-6"
        >
          <div className="flex flex-col gap-1.5">
            <h2 id={`part-${part.id}`} className="m-0 text-lg font-semibold">
              Part {part.id} · {part.title}
            </h2>
            <p className="m-0 max-w-prose text-sm text-muted-foreground">
              <Inline>{part.opens}</Inline>
            </p>
          </div>
          {part.material.map((material) => (
            <section
              key={material}
              aria-labelledby={`material-${material}`}
              className="flex min-w-0 flex-col gap-3"
            >
              <h3 id={`material-${material}`} className="m-0 text-base font-semibold">
                {MATERIAL_LABEL[material]}
              </h3>
              {MATERIAL_CAPTION[material] !== undefined && (
                <p className="m-0 max-w-prose text-sm text-muted-foreground">
                  {MATERIAL_CAPTION[material]}
                </p>
              )}
              {exercise[material] === undefined ? (
                <p className="m-0 text-sm text-muted-foreground">Not part of this exercise.</p>
              ) : (
                // Nothing is recorded in a preview, not even which files were opened.
                <MaterialContent exercise={exercise} material={material} onOpen={() => undefined} />
              )}
            </section>
          ))}
        </section>
      ))}
    </div>
  );
}

function ExercisePreview({
  code,
  parts,
  previous,
  next,
  go,
  focusHeading,
}: {
  code: string;
  parts: PreviewList["parts"];
  previous: PreviewEntry | undefined;
  next: PreviewEntry | undefined;
  go: (code: string) => void;
  /** Whether the reader moved here from another exercise, so the heading takes the focus. */
  focusHeading: boolean;
}) {
  const [load, setLoad] = useState<Load<PreviewExercise>>({ state: "loading" });
  useEffect(() => {
    api.admin.preview(code).then(
      (value) => setLoad({ state: "ready", value }),
      (error: unknown) => setLoad({ state: "error", error: failure(error) }),
    );
  }, [code]);
  const heading = useCallback(
    (element: HTMLHeadingElement | null) => {
      if (element !== null && focusHeading) element.focus();
    },
    [focusHeading],
  );
  if (load.state === "loading") {
    return (
      <div aria-busy="true" className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (load.state === "error") return <ErrorMessage error={load.error} />;
  const preview = load.value;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <StudyTeamHeader preview={preview} heading={heading} />
      <RatersView preview={preview} parts={parts} />
      <nav
        aria-label="Previous and next exercise"
        className="flex flex-wrap justify-between gap-4 border-t pt-6 text-sm"
      >
        {previous === undefined ? (
          <span />
        ) : (
          <a
            className={cn(linkClass, "inline-flex items-center gap-1")}
            href={hrefOf(previous.code)}
            onClick={(event) => inPage(event, () => go(previous.code))}
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            Previous: {entryLabel(previous)}
          </a>
        )}
        {next !== undefined && (
          <a
            className={cn(linkClass, "inline-flex items-center gap-1")}
            href={hrefOf(next.code)}
            onClick={(event) => inPage(event, () => go(next.code))}
          >
            Next: {entryLabel(next)}
            <ArrowRightIcon aria-hidden="true" className="size-4" />
          </a>
        )}
      </nav>
    </div>
  );
}

/**
 * The study team's read-only preview of every frozen exercise, as raters see its material with all
 * parts open. The survey server serves it behind the study team's link, and `exgen survey preview`
 * from the built files before deployment; both answer the same two requests, and neither opens a
 * step or records anything.
 */
export function Preview() {
  const [list, setList] = useState<Load<PreviewList>>({ state: "loading" });
  const [requested, setRequested] = useState<string | null>(codeOfPath);
  // Set once the reader moves between exercises; the first exercise shown keeps the focus at the top.
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    api.admin.previews().then(
      (value) => setList({ state: "ready", value }),
      (error: unknown) => setList({ state: "error", error: failure(error) }),
    );
  }, []);
  // The browser's back and forward buttons move between the exercises shown.
  useEffect(() => {
    const restore = () => {
      setMoved(true);
      setRequested(codeOfPath());
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const go = useCallback((next: string) => {
    window.history.pushState(null, "", hrefOf(next));
    setMoved(true);
    setRequested(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  const entries = list.state === "ready" ? list.value.exercises : [];
  // The preview's own address shows the first exercise, under that exercise's address.
  const code = requested ?? entries[0]?.code ?? null;
  useEffect(() => {
    if (requested === null && code !== null) {
      window.history.replaceState(null, "", hrefOf(code));
    }
  }, [requested, code]);
  const index = entries.findIndex((entry) => entry.code === code);
  const current = entries[index];
  const title = list.state === "ready" ? list.value.study.title : "Expert study";
  useEffect(() => {
    document.title =
      current === undefined ? `Preview · ${title}` : `Preview · ${entryLabel(current)} · ${title}`;
  }, [current, title]);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-3 focus:ring-ring/50"
      >
        Skip to the exercise
      </a>
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-2 sm:px-6">
          <p className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
            {title} <span className="font-normal text-muted-foreground">· exercise preview</span>
          </p>
          {list.state === "ready" && list.value.deployed && (
            <a className={cn(linkClass, "text-sm")} href="/">
              Back to the dashboard
            </a>
          )}
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
        <Alert role="note">
          <EyeIcon aria-hidden="true" />
          <AlertTitle>Preview — not a rater session; nothing is recorded</AlertTitle>
          <AlertDescription>
            {list.state === "ready" && !list.value.deployed
              ? "The built exercises on disk, verified against their frozen digests: what the survey server will serve once deployed. "
              : "The frozen exercises this survey serves. "}
            Every part's material is shown at once, as raters see it once they reach that part.
          </AlertDescription>
        </Alert>
        {list.state === "loading" && (
          <div aria-busy="true" className="flex justify-center py-16">
            <Spinner />
          </div>
        )}
        {list.state === "error" && (
          <main id="main-content" tabIndex={-1} className="outline-none">
            <ErrorMessage error={list.error} />
          </main>
        )}
        {list.state === "ready" && (
          <div className="grid min-w-0 gap-8 lg:grid-cols-12">
            <nav aria-label="Exercises" className="min-w-0 lg:col-span-3 xl:col-span-2">
              <h2 className="mt-0 mb-2 text-sm font-semibold">
                Exercises · {list.value.exercises.length}
              </h2>
              <ol className="m-0 flex list-none flex-col gap-1 p-0">
                {list.value.exercises.map((entry) => (
                  <li key={entry.code}>
                    <a
                      href={hrefOf(entry.code)}
                      aria-current={entry.code === code ? "page" : undefined}
                      onClick={(event) => inPage(event, () => go(entry.code))}
                      className="flex flex-col rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-muted aria-[current=page]:font-medium"
                    >
                      <span>
                        <span className="font-mono">{entry.code}</span>
                        {entry.title !== null && ` · ${entry.title}`}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {phaseLabel(entry.phase)} · {entry.id}
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            <main
              id="main-content"
              tabIndex={-1}
              className="min-w-0 outline-none lg:col-span-9 xl:col-span-10"
            >
              {current === undefined ? (
                code !== null && (
                  <Alert>
                    <AlertTitle>No exercise {code} in this study</AlertTitle>
                    <AlertDescription>Choose one of the study's exercises.</AlertDescription>
                  </Alert>
                )
              ) : (
                <ExercisePreview
                  key={current.code}
                  code={current.code}
                  parts={list.value.parts}
                  previous={entries[index - 1]}
                  next={entries[index + 1]}
                  go={go}
                  focusHeading={moved}
                />
              )}
            </main>
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}
