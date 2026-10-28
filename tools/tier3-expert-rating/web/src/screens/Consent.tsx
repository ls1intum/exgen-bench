import { ChevronDownIcon } from "lucide-react";
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
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";

import { api } from "../api.ts";
import { calendarDate } from "../dates.ts";
import { useLegalLink } from "../Legal.tsx";
import { Markdown } from "../material/Markdown.tsx";
import type { StepOf, StepProps } from "../step.ts";

/** The consent page: what the study is and stores, the statements to agree to, or a final decline. */
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
  const { contact } = session.study;
  const privacy = useLegalLink("privacy");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-prose flex-col gap-2">
        <h1 className="m-0 text-xl font-semibold">Welcome to the expert study</h1>
        {session.rater.deadline !== null && (
          <p className="m-0 text-sm text-muted-foreground">
            Please complete the study by {calendarDate(session.rater.deadline)}. You can pause
            between exercises and continue later with your link.
          </p>
        )}
      </div>
      <div className="flex max-w-prose flex-col gap-3">
        <Markdown>{step.summary}</Markdown>
        <Collapsible>
          <div className="-ml-2.5">
            <CollapsibleTrigger render={<Button variant="link" />}>
              Read the full consent information
              <ChevronDownIcon
                data-icon="inline-end"
                aria-hidden="true"
                className="transition-transform group-data-panel-open/button:rotate-180"
              />
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="mt-3 flex flex-col gap-3 border-l-2 pl-4">
              <Markdown>{step.details}</Markdown>
              <p className="m-0 text-sm text-muted-foreground">
                Contact: {contact.name},{" "}
                <a className="text-primary underline" href={`mailto:${contact.email}`}>
                  {contact.email}
                </a>
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>
        {privacy !== undefined && (
          <p className="m-0 text-sm text-muted-foreground">
            How the survey handles your data is explained in the{" "}
            <a
              className="rounded-sm text-primary underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              href={privacy.href}
            >
              privacy notice
            </a>
            .
          </p>
        )}
      </div>
      <FieldSet>
        <FieldLegend variant="label">Your consent</FieldLegend>
        <FieldGroup>
          {step.statements.map((statement) => (
            <FieldLabel key={statement.id} htmlFor={`${id}-${statement.id}`}>
              <Field orientation="horizontal">
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
                <FieldTitle>{statement.text}</FieldTitle>
              </Field>
            </FieldLabel>
          ))}
        </FieldGroup>
      </FieldSet>
      <div className="flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
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
              <AlertDialogAction variant="destructive" disabled={busy} onClick={() => send([])}>
                Decline
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          {!all && (
            <p className="m-0 text-sm text-muted-foreground">
              {step.statements.length === 1
                ? "Tick the statement to start."
                : "Tick every statement to start."}
            </p>
          )}
          <Button disabled={!all || busy} onClick={() => send(accepted)}>
            Agree and start
          </Button>
        </div>
      </div>
    </div>
  );
}
