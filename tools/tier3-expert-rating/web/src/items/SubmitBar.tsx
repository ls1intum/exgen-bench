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
        title="Your answers stay on this page and save with the next change."
      >
        · Not saved
      </span>
    );
  }
  return (
    <span>
      ·{" "}
      {save.state === "saving"
        ? "Saving…"
        : `Saved ${new Date(save.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
    </span>
  );
}

/**
 * The footer of a step: how many answers are given, whether they are saved, and the submit button.
 * With answers missing, the button shows what is missing on the page; with none, it asks for
 * confirmation, because a submitted step cannot be changed, and says what comes next.
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
  /** What the rater sees after submitting, such as the material of the next part. */
  next: string;
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
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="m-0 min-w-0 truncate text-sm text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          {answered} of {required}
        </span>{" "}
        answered{" "}
        <span role="status">
          <SaveStatus save={save} />
        </span>
      </p>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <Button onClick={() => (issues.length > 0 ? onReveal() : setOpen(true))}>{label}</Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit these answers?</AlertDialogTitle>
            <AlertDialogDescription>
              You cannot change them afterwards. Next: {next}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
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
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
