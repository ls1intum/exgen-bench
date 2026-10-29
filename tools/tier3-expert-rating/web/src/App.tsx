import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

import type { Session } from "../../shared/api.ts";
import { api, ApiError } from "./api.ts";
import { Footer } from "./Legal.tsx";
import { Briefs } from "./screens/Briefs.tsx";
import { Consent } from "./screens/Consent.tsx";
import { Finished } from "./screens/Finished.tsx";
import { Onboarding } from "./screens/Onboarding.tsx";
import { Questionnaire } from "./screens/Questionnaire.tsx";
import { Shell } from "./Shell.tsx";
import { screenOf, stepMoved } from "./step.ts";

// The code viewers and the study team's dashboard load when first shown.
const Rating = lazy(() =>
  import("./screens/Rating.tsx").then(({ Rating }) => ({ default: Rating })),
);
const Admin = lazy(() => import("./screens/Admin.tsx").then(({ Admin }) => ({ default: Admin })));

const loading = (
  <div aria-busy="true" className="flex min-h-dvh items-center justify-center">
    <Spinner />
  </div>
);

type Load =
  { state: "loading" } | { state: "ready"; session: Session } | { state: "error"; error: ApiError };

/**
 * The survey follows the server: the app asks which step the rater is on and renders that step.
 * Submitting a step returns the next one, so the app never decides on its own what comes next.
 */
export function App() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const screen = useRef<string | null>(null);

  const accept = useCallback((session: Session) => {
    // A new step moves the focus to its heading; the first page a link opens keeps it at the top.
    const next = session.kind === "rater" ? screenOf(session.step) : null;
    if (screen.current !== null && next !== screen.current) stepMoved();
    screen.current = next;
    setLoad({ state: "ready", session });
    // A new step is a new page, so it starts at its top without the page's smooth scrolling.
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  const fail = useCallback((error: unknown) => {
    setLoad({
      state: "error",
      error:
        error instanceof ApiError ? error : new ApiError(0, "The study server cannot be reached."),
    });
  }, []);

  useEffect(() => {
    api.session().then(accept, fail);
  }, [accept, fail]);

  if (load.state === "loading") {
    return loading;
  }
  if (load.state === "error") {
    return (
      <div className="flex min-h-dvh flex-col">
        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-3 px-4 py-16 sm:px-6 sm:py-24">
          {load.error.status === 401 ? (
            // Not an error: everyone without a personal link lands here, including the curious.
            <>
              <h1 className="m-0 text-xl font-semibold">Open your personal link</h1>
              <p className="m-0 text-muted-foreground">
                This study is reached through the personal link the study team sent you. Open that
                link to start or continue; if it no longer works, ask the study team for a new one.
              </p>
            </>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>
                {`${load.error.message} Reload the page to try again; your saved answers are kept.`}
              </AlertDescription>
            </Alert>
          )}
        </main>
        <Footer inner="mx-auto max-w-xl" />
      </div>
    );
  }

  const { session } = load;
  if (session.kind === "admin") {
    return (
      <Suspense fallback={loading}>
        <Admin title={session.study.title} />
      </Suspense>
    );
  }
  const { step } = session;
  const props = { session, onSession: accept, onError: fail };
  return (
    <Shell session={session} wide={step.kind === "part"}>
      {step.kind === "consent" && <Consent {...props} step={step} />}
      {(step.kind === "background" || step.kind === "exit") && (
        <Questionnaire {...props} step={step} />
      )}
      {step.kind === "onboarding" && <Onboarding {...props} step={step} />}
      {step.kind === "part" && (
        <Suspense fallback={loading}>
          <Rating {...props} step={step} />
        </Suspense>
      )}
      {step.kind === "briefs" && <Briefs {...props} step={step} />}
      {(step.kind === "waiting" || step.kind === "done" || step.kind === "declined") && (
        <Finished session={session} kind={step.kind} />
      )}
    </Shell>
  );
}
