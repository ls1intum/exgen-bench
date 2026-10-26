import { useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";

import { api } from "../api.ts";
import { calendarDate } from "../dates.ts";
import { Markdown } from "../material/Markdown.tsx";
import type { StepOf, StepProps } from "../step.ts";

export function Consent({ session, step, onSession, onError }: StepProps<StepOf<"consent">>) {
  const id = useId();
  const [accepted, setAccepted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const all = step.statements.every((statement) => accepted.includes(statement.id));
  const send = (ids: string[]) => {
    setBusy(true);
    api
      .consent(ids)
      .then(onSession, onError)
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="mt-0 mb-2 text-2xl font-semibold">Welcome to the expert study</h1>
        {session.rater.deadline !== null && (
          <p className="m-0 text-sm text-muted-foreground">
            Please complete the study by {calendarDate(session.rater.deadline)}. You can pause
            between exercises and continue later with your link.
          </p>
        )}
      </div>
      <Markdown>{step.summary}</Markdown>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="link" />}>
          Read the full consent information
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Markdown>{step.details}</Markdown>
          <p className="text-sm text-muted-foreground">
            Contact: {session.study.contact.name},{" "}
            <a className="text-primary underline" href={`mailto:${session.study.contact.email}`}>
              {session.study.contact.email}
            </a>
          </p>
        </CollapsibleContent>
      </Collapsible>
      <div className="flex flex-col gap-3">
        {step.statements.map((statement) => (
          <Field key={statement.id} orientation="horizontal">
            <Checkbox
              id={`${id}-${statement.id}`}
              checked={accepted.includes(statement.id)}
              onCheckedChange={(checked) =>
                setAccepted((previous) =>
                  checked
                    ? [...previous, statement.id]
                    : previous.filter((value) => value !== statement.id),
                )
              }
            />
            <FieldLabel htmlFor={`${id}-${statement.id}`}>{statement.text}</FieldLabel>
          </Field>
        ))}
      </div>
      <div className="flex justify-end gap-3">
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="outline" disabled={busy} />}>
            Decline
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Decline to take part?</AlertDialogTitle>
              <AlertDialogDescription>
                Nothing else is stored, and declining is final: this link will then only show that
                you declined.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Back</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => send([])}>
                Decline
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button disabled={!all || busy} onClick={() => send(accepted)}>
          Agree and start
        </Button>
      </div>
    </div>
  );
}
