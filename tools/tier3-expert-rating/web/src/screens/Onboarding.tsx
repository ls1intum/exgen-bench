import { cn } from "cn";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { api } from "../api.ts";
import { Markdown } from "../material/Markdown.tsx";
import { stepHeading, type StepOf, type StepProps } from "../step.ts";

/** The introduction: a few pages the rater can page through freely, since nothing is answered. */
export function Onboarding({ session, step, onSession, onError }: StepProps<StepOf<"onboarding">>) {
  const { pages, title } = session.instrument.onboarding;
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(index);
  // A page turn replaces the buttons under the pointer; focus moves to the new page's title, which
  // also announces it. Arriving from the consent page does the same.
  useEffect(() => stepHeading(heading.current), []);
  useEffect(() => {
    if (shown.current !== index) {
      shown.current = index;
      heading.current?.focus();
    }
  }, [index]);
  const page = pages[index];
  if (page === undefined) {
    return null;
  }
  const last = index === pages.length - 1;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <p className="m-0 text-sm text-muted-foreground">
            {title} · page {index + 1} of {pages.length}
          </p>
          <ol aria-hidden="true" className="m-0 flex list-none gap-1 p-0">
            {pages.map((candidate, position) => (
              <li
                key={candidate.title}
                className={cn(
                  "h-1.5 w-4 rounded-full",
                  position <= index ? "bg-primary" : "bg-border",
                )}
              />
            ))}
          </ol>
        </div>
        <h1 ref={heading} tabIndex={-1} className="m-0 text-xl font-semibold outline-none">
          {page.title}
        </h1>
      </div>
      <div className="max-w-prose">
        <Markdown>{page.body}</Markdown>
      </div>
      <div className="flex items-center justify-between gap-3 border-t pt-6">
        {index > 0 ? (
          <Button variant="outline" onClick={() => setIndex(index - 1)}>
            Back
          </Button>
        ) : (
          <span />
        )}
        {last ? (
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api
                .submit(step.key, {})
                .then(onSession, onError)
                .finally(() => setBusy(false));
            }}
          >
            Continue to the questions about you
          </Button>
        ) : (
          <Button onClick={() => setIndex(index + 1)}>Next</Button>
        )}
      </div>
    </div>
  );
}
