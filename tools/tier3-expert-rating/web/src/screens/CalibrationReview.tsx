import { cn } from "cn";
import { CheckIcon, ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";

import type { Answer, Item as Question } from "../../../shared/instrument.ts";
import { api } from "../api.ts";
import { describeAnswer } from "../items/describe.ts";
import { Inline } from "../items/ItemField.tsx";
import type { StepOf, StepProps } from "../step.ts";

interface Reviewed {
  item: Question;
  reference: { answer: Answer; explanation: string } | undefined;
  own: Answer | undefined;
  same: boolean;
}

/** One practice item: the question, both answers, and why the study team answered as it did. */
function Comparison({ entry }: { entry: Reviewed }) {
  const { item, reference, own, same } = entry;
  return (
    <li className="flex flex-col gap-4 rounded-lg border p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="m-0 text-sm font-medium">
          <Inline>{item.prompt}</Inline>
        </p>
        {same ? (
          <Badge variant="secondary">
            <CheckIcon data-icon="inline-start" aria-hidden="true" />
            Same as ours
          </Badge>
        ) : (
          <Badge variant="warning">
            <TriangleAlertIcon data-icon="inline-start" aria-hidden="true" />
            Differs
          </Badge>
        )}
      </div>
      <dl className="m-0 grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1 rounded-md border border-transparent bg-muted p-3">
          <dt className="text-xs text-muted-foreground">Your answer</dt>
          <dd className="m-0">{describeAnswer(item, own)}</dd>
        </div>
        <div
          className={cn(
            "flex flex-col gap-1 rounded-md border p-3",
            same ? "border-transparent bg-muted" : "border-warning-border bg-warning-surface",
          )}
        >
          <dt className="text-xs text-muted-foreground">Our answer</dt>
          <dd className="m-0">{describeAnswer(item, reference?.answer)}</dd>
        </div>
        {reference !== undefined && (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Why</dt>
            <dd className="m-0 text-sm leading-6">
              <Inline>{reference.explanation}</Inline>
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

/**
 * The study team's answers to the practice exercise next to the rater's. Nothing is scored; items
 * whose answers differ lead, because their explanations are the ones worth reading, and matching
 * items fold into one row.
 */
export function CalibrationReview({
  session,
  step,
  onSession,
  onError,
}: StepProps<StepOf<"calibration_review">>) {
  const [busy, setBusy] = useState(false);
  const reviewed: Reviewed[] = session.instrument.calibration.items.map((item) => {
    const reference = step.reference[item.id];
    const own = step.answers[item.id];
    return {
      item,
      reference,
      own,
      same: reference !== undefined && own?.value === reference.answer.value,
    };
  });
  const differing = reviewed.filter((entry) => !entry.same);
  const matching = reviewed.filter((entry) => entry.same);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-prose flex-col gap-2">
        <h1 className="m-0 text-xl font-semibold">How we read the practice exercise</h1>
        <p className="m-0 text-sm text-muted-foreground">
          {matching.length} of {reviewed.length} of your answers match ours.{" "}
          {differing.length > 0 && "Please read why we answered the others as we did. "}
          Your answers are not analysed, and you do not need to change anything.
        </p>
      </div>
      {differing.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {differing.map((entry) => (
            <Comparison key={entry.item.id} entry={entry} />
          ))}
        </ul>
      )}
      {matching.length > 0 && (
        <Collapsible defaultOpen={differing.length === 0}>
          <div className="flex flex-col gap-4">
            <CollapsibleTrigger
              // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the trigger's children label it.
              render={<Item variant="outline" render={<button type="button" />} />}
            >
              <ItemMedia variant="icon">
                <CheckIcon aria-hidden="true" className="text-success" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {matching.length} of your answers {matching.length === 1 ? "matches" : "match"}{" "}
                  ours
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground transition-transform group-data-panel-open/item:rotate-180"
                />
              </ItemActions>
            </CollapsibleTrigger>
            <CollapsibleContent hiddenUntilFound>
              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {matching.map((entry) => (
                  <Comparison key={entry.item.id} entry={entry} />
                ))}
              </ul>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
      <div className="flex justify-end border-t pt-6">
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
