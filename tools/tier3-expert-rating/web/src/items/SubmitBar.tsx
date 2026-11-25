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
  if (save.state === "idle") return null;
  if (save.state === "failed") {
    return (
      <span
        className="text-warning"
        title="Keep this page open. Your next edit will try saving again."
      >
        Not saved
      </span>
    );
  }
  return (
    <span>
      {save.state === "saving"
        ? "Saving…"
        : `Saved ${new Date(save.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
    </span>
  );
}

/**
 * The footer of a step: how many answers are given, whether they are saved, and the submit button.
 * With answers missing, the button shows what is missing. A next-step description asks the rater
 * to confirm before crossing a review boundary.
 */
export function SubmitBar({
  label,
  next,
  save,
  issues,
  answered,
  required,
  onReveal,
  onSubmit,
  onSession,
  onError,
}: {
  label: string;
  /** With this description, confirm before submitting. Without it, submit directly. */
  next?: string | undefined;
  save: SaveState;
  issues: AnswerIssue[];
  answered: number;
  required: number;
  onReveal: () => void;
  onSubmit: () => Promise<Session>;
  onSession: (session: Session) => void;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = () => {
    setBusy(true);
    onSubmit()
      .then(onSession, (error: unknown) => {
        setOpen(false);
        onError(error);
      })
      .finally(() => setBusy(false));
  };
  const button = (
    <Button
      disabled={busy}
      onClick={() => {
        if (issues.length > 0) onReveal();
        else if (next === undefined) submit();
        else setOpen(true);
      }}
    >
      {label}
    </Button>
  );
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="m-0 min-w-0 truncate text-sm text-muted-foreground">
        {required > 0 && (
          <>
            <span className="font-medium text-foreground tabular-nums">
              {answered} of {required}
            </span>{" "}
            answered{save.state !== "idle" && " · "}
          </>
        )}
        <span role="status">
          <SaveStatus save={save} />
        </span>
      </p>
      {next === undefined ? (
        button
      ) : (
        <AlertDialog open={open} onOpenChange={setOpen}>
          {button}
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Submit these answers?</AlertDialogTitle>
              <AlertDialogDescription>
                You cannot change them afterwards. Next: {next}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={submit}>
                Submit
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
