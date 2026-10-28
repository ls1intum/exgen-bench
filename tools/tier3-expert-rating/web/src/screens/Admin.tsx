import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { api } from "../api.ts";
import { Footer } from "../Legal.tsx";
import { Changes } from "./admin/Changes.tsx";
import { type Actions, LinkDialog } from "./admin/dialogs.tsx";
import { Exercises } from "./admin/Exercises.tsx";
import { Export } from "./admin/Export.tsx";
import { Insights } from "./admin/Insights.tsx";
import { inactiveDays, overdue, type Overview } from "./admin/model.ts";
import { Raters } from "./admin/Raters.tsx";

/** How often the dashboard follows the study while its tab is visible. */
const REFRESH_MS = 30_000;

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function Kpi({
  value,
  label,
  detail,
  warn = false,
}: {
  value: string;
  label: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <p className="m-0 text-xl font-semibold tabular-nums">{value}</p>
      <p className="m-0 text-sm text-muted-foreground">{label}</p>
      {detail !== undefined && (
        <p className={warn ? "m-0 text-xs text-destructive" : "m-0 text-xs text-muted-foreground"}>
          {detail}
        </p>
      )}
    </div>
  );
}

/**
 * Where the study stands. A study with main raters counts their planned ratings, which the analysis
 * uses; a pilot, which has none, counts every rating.
 */
function Summary({ overview }: { overview: Overview }) {
  // The study team's own test raters do not count.
  const raters = overview.raters.filter(
    (rater) => rater.role !== "test" && !rater.withdrawn && rater.status !== "Declined",
  );
  const main = raters.filter((rater) => rater.role === "main");
  const counted = main.length > 0 ? main : raters;
  const done = counted.filter((rater) => rater.status === "Done").length;
  const ratings =
    main.length > 0
      ? {
          done: overview.exercises.reduce((sum, exercise) => sum + exercise.readiness.length, 0),
          planned: overview.exercises.length * overview.study.ratingsPerExercise,
          label: "Planned ratings complete",
        }
      : {
          done: overview.exercises.reduce((sum, exercise) => sum + exercise.ratings, 0),
          planned: raters.reduce((sum, rater) => sum + rater.exercises.length, 0),
          label: "Ratings complete",
        };
  const late = raters.filter((rater) => overdue(rater)).length;
  const idle = raters.filter((rater) => inactiveDays(rater) !== null).length;
  const differ = overview.exercises.filter((exercise) => exercise.agreement === "differ").length;
  const attention = [
    late > 0 && `${late} overdue`,
    idle > 0 && `${idle} idle`,
    differ > 0 && `${differ} to settle`,
  ].filter(Boolean);
  const timed = overview.timing.filter((part) => part.median !== null);
  const minutes = timed.reduce((sum, part) => sum + (part.median ?? 0), 0);
  const budget = overview.timing.reduce((sum, part) => sum + part.budget, 0);
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <Kpi
        value={counted.length === 0 ? "—" : `${done} / ${counted.length}`}
        label={main.length > 0 ? "Main raters done" : "Raters done"}
      />
      <Kpi
        value={ratings.planned === 0 ? "—" : `${ratings.done} / ${ratings.planned}`}
        label={ratings.label}
      />
      <Kpi
        value={String(late + idle + differ)}
        label="Need attention"
        detail={
          attention.length === 0 ? "Nothing overdue, idle, or to settle" : attention.join(" · ")
        }
      />
      <Kpi
        value={timed.length === 0 ? "—" : `${Math.round(minutes)} min`}
        label="Median time per exercise"
        detail={
          timed.length === 0
            ? `Budget ${budget} min`
            : timed.length < overview.timing.length
              ? `Budget ${budget} min; not every part timed yet`
              : minutes > budget
                ? `${Math.round(minutes - budget)} min over the ${budget} min budget`
                : `Within the ${budget} min budget`
        }
        warn={timed.length === overview.timing.length && minutes > budget}
      />
    </div>
  );
}

/** The study team's view: progress and insights, and the changes the team makes while it runs. */
export function Admin({ title }: { title: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ rater: string; url: string } | null>(null);
  const accept = useCallback((next: Overview) => {
    setOverview(next);
    setUpdated(new Date());
    setError(null);
  }, []);
  const fail = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );
  const refresh = useCallback(() => api.admin.overview().then(accept, fail), [accept, fail]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const actions = useMemo<Actions | null>(
    () =>
      overview === null
        ? null
        : { overview, accept, fail, showLink: (rater, url) => setLink({ rater, url }) },
    [overview, accept, fail],
  );
  if (overview === null || actions === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        {error === null ? (
          <Spinner />
        ) : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-2 sm:px-6">
          <p className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
            {title} <span className="font-normal text-muted-foreground">· study team</span>
          </p>
          {updated !== null && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Updated {TIME.format(updated)}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshCwIcon />
          </Button>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
        <h1 className="sr-only">Study dashboard</h1>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Summary overview={overview} />
        <Tabs defaultValue="raters">
          <div className="overflow-x-auto">
            <TabsList>
              <TabsTrigger value="raters">Raters · {overview.raters.length}</TabsTrigger>
              <TabsTrigger value="exercises">Exercises · {overview.exercises.length}</TabsTrigger>
              <TabsTrigger value="insights">Insights</TabsTrigger>
              <TabsTrigger value="changes">Changes · {overview.changes.length}</TabsTrigger>
              <TabsTrigger value="export">Export</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            className="rounded-md focus-visible:ring-3 focus-visible:ring-ring/50"
            value="raters"
          >
            <div className="pt-4">
              <Raters actions={actions} />
            </div>
          </TabsContent>
          <TabsContent
            className="rounded-md focus-visible:ring-3 focus-visible:ring-ring/50"
            value="exercises"
          >
            <div className="pt-4">
              <Exercises actions={actions} />
            </div>
          </TabsContent>
          <TabsContent
            className="rounded-md focus-visible:ring-3 focus-visible:ring-ring/50"
            value="insights"
          >
            <div className="pt-4">
              <Insights overview={overview} />
            </div>
          </TabsContent>
          <TabsContent
            className="rounded-md focus-visible:ring-3 focus-visible:ring-ring/50"
            value="changes"
          >
            <div className="pt-4">
              <Changes overview={overview} />
            </div>
          </TabsContent>
          <TabsContent
            className="rounded-md focus-visible:ring-3 focus-visible:ring-ring/50"
            value="export"
          >
            <div className="pt-4">
              <Export overview={overview} />
            </div>
          </TabsContent>
        </Tabs>
      </main>
      <Footer />
      <LinkDialog link={link} onClose={() => setLink(null)} />
    </div>
  );
}
