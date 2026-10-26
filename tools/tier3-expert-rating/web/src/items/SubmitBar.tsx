import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import type { Session } from "../../../shared/api.ts";
import type { AnswerIssue } from "../../../shared/instrument.ts";
import type { SaveState } from "./useAnswers.ts";

function SaveStatus({ save }: { save: SaveState }) {
  const text =
    save.state === "saving"
      ? "Saving…"
      : save.state === "saved"
        ? `Draft saved at ${new Date(save.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : save.state === "failed"
          ? "The draft could not be saved; your answers stay on this page."
          : "";
  return (
    <p role="status" className="m-0 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

/**
 * The submit button of a step. Submitting is final, so it asks for confirmation and says what comes
 * next; with answers missing, it lists them instead and marks them on the page.
 */
export function SubmitBar({
  label,
  next,
  save,
  issues,
  onReveal,
  onSubmit,
  onSession,
  onError,
}: {
  label: string;
  /** What the rater sees after submitting, such as the material of the next part. */
  next: string;
  save: SaveState;
  issues: AnswerIssue[];
  onReveal: () => void;
  onSubmit: () => Promise<Session>;
  onSession: (session: Session) => void;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-end gap-4 border-t pt-4">
      <SaveStatus save={save} />
      <AlertDialog open={open} onOpenChange={setOpen}>
        <Button
          onClick={() => {
            if (issues.length > 0) onReveal();
            setOpen(true);
          }}
        >
          {label}
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {issues.length > 0 ? "Some answers are missing" : "Submit these answers?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {issues.length > 0
                ? "Please complete these items first. They are marked on the page."
                : `You cannot change these answers afterwards. Next: ${next}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {issues.length > 0 && (
            <ul className="m-0 pl-5 text-sm">
              {issues.map((issue) => (
                <li key={issue.item}>
                  {issue.item} {issue.message}
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>
              {issues.length > 0 ? "Back to the answers" : "Cancel"}
            </AlertDialogCancel>
            {issues.length === 0 && (
              <AlertDialogAction
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  onSubmit()
                    .then(onSession, (error: unknown) => {
                      setOpen(false);
                      onError(error);
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Submit
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
