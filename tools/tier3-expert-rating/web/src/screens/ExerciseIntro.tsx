import { CircleCheckIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { api } from "../api.ts";
import type { StepOf, StepProps } from "../step.ts";

/** Before an exercise's first part: the four parts ahead, their time, and room for a break. */
export function ExerciseIntro({ session, step, onSession, onError }: StepProps<StepOf<"part">>) {
  const [busy, setBusy] = useState(false);
  const { parts } = session.instrument.questionnaire;
  const minutes = parts.reduce((sum, part) => sum + part.minutes, 0);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      {step.position > 1 && (
        <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
          Exercise {step.position - 1} is done and saved. Take a break if you like; you can close
          this page and continue later with your link.
        </p>
      )}
      <div className="flex max-w-prose flex-col gap-2">
        <h1 className="m-0 text-xl font-semibold">
          Exercise {step.position} of {step.total}
        </h1>
        <p className="m-0 text-sm text-muted-foreground">
          You rate the exercise in four parts, about {minutes} minutes in all. Each part adds
          material next to its questions. Once you submit a part, you cannot return to it; if later
          material changes your view, say so in the remarks of Part D.
        </p>
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {parts.map((part, index) => {
          const dimensions = [
            ...new Set(
              part.items.flatMap((item) =>
                item.kind === "choice" && item.dimension !== undefined ? [item.dimension] : [],
              ),
            ),
          ];
          // Optional items are free-text remarks; the count matches the "answered" count of the part.
          const optional = (item: (typeof part.items)[number]) =>
            // A text item that is required unless another answer waives it counts as a question,
            // as it does in the footer while the rater answers.
            item.kind === "text" && !item.required && item.optional_when === undefined;
          const required = part.items.filter((item) => !optional(item)).length;
          const remarks = part.items.some(optional);
          const last = index === parts.length - 1;
          return (
            <li key={part.id} className="flex gap-4">
              <div className="flex flex-col items-center">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
                  {part.id}
                </span>
                {!last && <span aria-hidden="true" className="w-px flex-1 bg-border" />}
              </div>
              <div className={last ? "flex flex-col gap-1" : "flex flex-col gap-1 pb-6"}>
                <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{part.title}</span>
                  <span className="text-muted-foreground">about {part.minutes} min</span>
                </p>
                <p className="m-0 text-sm text-muted-foreground">
                  {required} {required === 1 ? "question" : "questions"}
                  {remarks && " + optional remarks"}
                  {dimensions.length > 0 && ` · ${dimensions.join(", ")}`}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex justify-end border-t pt-6">
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .open(step.key)
              .then(onSession, onError)
              .finally(() => setBusy(false));
          }}
        >
          Start Part A
        </Button>
      </div>
    </div>
  );
}
