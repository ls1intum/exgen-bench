import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { api } from "../api.ts";
import { describeAnswer } from "../items/describe.ts";
import { Inline } from "../items/ItemField.tsx";
import type { StepOf, StepProps } from "../step.ts";

/** The study team's answers to the practice exercise next to the rater's. Nothing is scored. */
export function CalibrationReview({
  session,
  step,
  onSession,
  onError,
}: StepProps<StepOf<"calibration_review">>) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="mt-0 mb-2 text-2xl font-semibold">How we read the practice exercise</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Your answers are not analysed. Where they differ from ours, please read the explanation;
          you do not need to change anything.
        </p>
      </div>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {session.instrument.calibration.items.map((item) => {
          const reference = step.reference[item.id];
          const own = step.answers[item.id];
          const same = reference !== undefined && own?.value === reference.answer.value;
          return (
            <li key={item.id} className="rounded-lg border p-4">
              <p className="mt-0 mb-3 text-sm font-medium">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{item.id}</span>
                <Inline>{item.prompt}</Inline>
              </p>
              <dl className="m-0 grid grid-cols-4 gap-x-4 gap-y-2 text-sm">
                <dt className="col-span-1 text-muted-foreground">Your answer</dt>
                <dd className="col-span-3 m-0 flex flex-wrap items-center gap-2">
                  {describeAnswer(item, own)}
                  <Badge variant={same ? "secondary" : "outline"}>
                    {same ? "Same as ours" : "Differs"}
                  </Badge>
                </dd>
                <dt className="col-span-1 text-muted-foreground">Our answer</dt>
                <dd className="col-span-3 m-0">{describeAnswer(item, reference?.answer)}</dd>
                <dt className="col-span-1 text-muted-foreground">Why</dt>
                <dd className="col-span-3 m-0">{reference?.explanation}</dd>
              </dl>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end border-t pt-4">
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
          Continue to the exercises
        </Button>
      </div>
    </div>
  );
}
