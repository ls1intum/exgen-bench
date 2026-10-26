import { useState } from "react";

import { Button } from "@/components/ui/button";

import { api } from "../api.ts";
import { Markdown } from "../material/Markdown.tsx";
import type { StepOf, StepProps } from "../step.ts";

/** The introduction: a few pages the rater can page through freely, since nothing is answered. */
export function Onboarding({ session, step, onSession, onError }: StepProps<StepOf<"onboarding">>) {
  const { pages, title } = session.instrument.onboarding;
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const page = pages[index];
  if (page === undefined) {
    return null;
  }
  const last = index === pages.length - 1;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="m-0 text-sm text-muted-foreground">
          {title} · page {index + 1} of {pages.length}
        </p>
        <h1 className="mt-1 mb-0 text-2xl font-semibold">{page.title}</h1>
      </div>
      <Markdown>{page.body}</Markdown>
      <div className="flex justify-between gap-3 border-t pt-4">
        <Button variant="outline" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          Back
        </Button>
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
            Start the practice exercise
          </Button>
        ) : (
          <Button onClick={() => setIndex(index + 1)}>Next</Button>
        )}
      </div>
    </div>
  );
}
