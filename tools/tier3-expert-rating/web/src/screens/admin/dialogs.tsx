import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import type { AssignmentKind, Role } from "../../../../shared/api.ts";
import { api } from "../../api.ts";
import {
  type Exercise,
  KIND_LABEL,
  nextId,
  type Overview,
  type Rater,
  ROLE_LABEL,
  usualDeadline,
} from "./model.ts";

/** What every dialog that changes the study needs: the new overview, or the error. */
export interface Actions {
  overview: Overview;
  accept: (next: Overview) => void;
  /** Show an error on the page; a dialog shows its own errors instead. */
  fail: (error: unknown) => void;
  /** Show a personal link once, right after it was issued. */
  showLink: (rater: string, url: string) => void;
}

/** A personal link, shown once with a button that copies it. */
export function LinkDialog({
  link,
  onClose,
}: {
  link: { rater: string; url: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Personal link for {link?.rater}</DialogTitle>
          <DialogDescription>
            Send it to the rater privately. It is shown only now; earlier links of the rater no
            longer work.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={link?.url ?? ""} aria-label="Personal link" />
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(link?.url ?? "").then(() => setCopied(true));
            }}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The message of a refused request, as a dialog shows it. */
export function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.charAt(0).toUpperCase() + message.slice(1);
}

function DialogError({ error }: { error: string | null }) {
  return error === null ? null : (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

function Cancel({ disabled }: { disabled: boolean }) {
  return (
    <DialogClose render={<Button variant="outline" disabled={disabled} />}>Cancel</DialogClose>
  );
}

/** Ask before a change that cannot be taken back, such as revoking a link. */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  action,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  action: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onConfirm().finally(() => {
                setBusy(false);
                onOpenChange(false);
              });
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Exercises to tick, in the order they are ticked; that is the order the rater rates them in. */
function ExercisePicker({
  exercises,
  taken,
  suggested,
  chosen,
  onChosen,
}: {
  exercises: Exercise[];
  taken: string[];
  suggested: string[];
  chosen: string[];
  onChosen: (next: string[]) => void;
}) {
  const id = useId();
  return (
    <FieldSet>
      <FieldLegend variant="label">Exercises</FieldLegend>
      <FieldDescription>The rater rates them in the order you tick them.</FieldDescription>
      <FieldGroup>
        {exercises.map((exercise) => {
          const position = chosen.indexOf(exercise.code);
          return (
            <Field key={exercise.code} orientation="horizontal">
              <Checkbox
                id={`${id}-${exercise.code}`}
                disabled={taken.includes(exercise.code)}
                checked={position >= 0}
                onCheckedChange={(checked) =>
                  onChosen(
                    checked
                      ? [...chosen, exercise.code]
                      : chosen.filter((code) => code !== exercise.code),
                  )
                }
              />
              <FieldLabel htmlFor={`${id}-${exercise.code}`}>
                {position >= 0 ? `${position + 1}. ` : ""}
                {exercise.code}
                <span className="font-normal text-muted-foreground">
                  {exercise.phase} · {exercise.id}
                  {taken.includes(exercise.code) && " · already assigned"}
                  {suggested.includes(exercise.code) && " · suggested"}
                </span>
              </FieldLabel>
            </Field>
          );
        })}
      </FieldGroup>
    </FieldSet>
  );
}

const KIND_HELP: Record<Exclude<AssignmentKind, "planned">, string> = {
  additional: "An extra rating, such as a pilot rating a study exercise. It counts on its own.",
  backup: "Stands in for another rater's rating of the same exercise, for example after a dropout.",
  tie_breaker: "A further rating of an exercise whose two readiness ratings disagree.",
};

/** Assign exercises to a rater; without a fixed rater, the dialog asks which one. */
export function AssignDialog({
  open,
  onOpenChange,
  actions,
  rater: fixed,
  kind: initialKind = "additional",
  exercises: initialExercises = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: Actions;
  rater?: Rater;
  kind?: Exclude<AssignmentKind, "planned">;
  exercises?: string[];
}) {
  const id = useId();
  const { overview } = actions;
  // Raters who could take the exercises first: main and reserve, then pilots and tests.
  const order: Role[] = ["main", "reserve", "pilot", "test"];
  const candidates = overview.raters
    .filter((rater) => !rater.withdrawn)
    .toSorted((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const [chosenRater, setChosenRater] = useState<string>(fixed?.id ?? "");
  const [kind, setKind] = useState(initialKind);
  const [replaces, setReplaces] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>(initialExercises);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rater = fixed ?? overview.raters.find((candidate) => candidate.id === chosenRater);
  const taken = rater?.exercises.map((exercise) => exercise.code) ?? [];
  const replaceable = overview.raters.filter(
    (candidate) => candidate.id !== rater?.id && candidate.exercises.length > 0,
  );
  const suggested =
    kind === "tie_breaker"
      ? overview.exercises
          .filter((exercise) => exercise.agreement === "differ")
          .map((exercise) => exercise.code)
      : kind === "backup"
        ? (overview.raters.find((candidate) => candidate.id === replaces)?.exercises ?? [])
            .filter((exercise) => !exercise.complete)
            .map((exercise) => exercise.code)
        : [];
  const total = taken.length + chosen.length;
  const ready =
    rater !== undefined && chosen.length > 0 && (kind !== "backup" || replaces !== null);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {fixed === undefined ? "Assign exercises" : `Assign exercises to ${fixed.id}`}
          </DialogTitle>
          <DialogDescription>
            The exercises come after the rater's current ones. You can remove an exercise again
            until the rater starts it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-120 flex-col gap-5 overflow-y-auto pr-1">
          {fixed === undefined && (
            <FieldSet>
              <FieldLegend variant="label">Rater</FieldLegend>
              <RadioGroup
                value={chosenRater}
                onValueChange={(value) => setChosenRater(value as string)}
              >
                {candidates.map((candidate) => {
                  const rated = initialExercises.filter((code) =>
                    candidate.exercises.some((exercise) => exercise.code === code),
                  );
                  return (
                    <Field
                      key={candidate.id}
                      orientation="horizontal"
                      data-disabled={rated.length > 0 || undefined}
                    >
                      <RadioGroupItem
                        id={`${id}-r-${candidate.id}`}
                        value={candidate.id}
                        disabled={rated.length > 0}
                      />
                      <FieldLabel htmlFor={`${id}-r-${candidate.id}`}>
                        {candidate.id}
                        <span className="font-normal text-muted-foreground">
                          {ROLE_LABEL[candidate.role]} · {candidate.status}
                          {rated.length > 0 && ` · rates ${rated.join(", ")}`}
                        </span>
                      </FieldLabel>
                    </Field>
                  );
                })}
              </RadioGroup>
            </FieldSet>
          )}
          <FieldSet>
            <FieldLegend variant="label">Kind of rating</FieldLegend>
            <RadioGroup
              value={kind}
              onValueChange={(value) => setKind(value as Exclude<AssignmentKind, "planned">)}
            >
              {(["additional", "backup", "tie_breaker"] as const).map((option) => (
                <Field key={option} orientation="horizontal">
                  <RadioGroupItem id={`${id}-k-${option}`} value={option} />
                  <FieldContent>
                    <FieldLabel htmlFor={`${id}-k-${option}`}>{KIND_LABEL[option]}</FieldLabel>
                    <FieldDescription>{KIND_HELP[option]}</FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          {kind === "backup" && (
            <FieldSet>
              <FieldLegend variant="label">Stands in for</FieldLegend>
              <RadioGroup value={replaces} onValueChange={(value) => setReplaces(value as string)}>
                {replaceable.map((candidate) => (
                  <Field key={candidate.id} orientation="horizontal">
                    <RadioGroupItem id={`${id}-b-${candidate.id}`} value={candidate.id} />
                    <FieldLabel htmlFor={`${id}-b-${candidate.id}`}>
                      {candidate.id}
                      <span className="font-normal text-muted-foreground">{candidate.status}</span>
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
          )}
          <ExercisePicker
            exercises={overview.exercises}
            taken={taken}
            suggested={suggested}
            chosen={chosen}
            onChosen={setChosen}
          />
          {rater !== undefined && total > 3 && (
            <p className="m-0 text-sm text-muted-foreground">
              {rater.id} will have {total} exercises, about {total * 20} minutes of rating.
            </p>
          )}
          {rater?.lookedBack && chosen.length > 0 && (
            <p className="m-0 text-sm text-muted-foreground">
              {rater.id} has answered “Looking back”; the new exercises come after it.
            </p>
          )}
          <DialogError error={error} />
        </div>
        <DialogFooter>
          <Cancel disabled={busy} />
          <Button
            disabled={!ready || busy}
            onClick={() => {
              if (rater === undefined) return;
              setBusy(true);
              setError(null);
              api.admin
                .assign({
                  rater: rater.id,
                  kind,
                  replaces: kind === "backup" ? replaces : null,
                  exercises: chosen,
                })
                .then(
                  (next) => {
                    actions.accept(next);
                    setChosen([]);
                    onOpenChange(false);
                  },
                  (cause: unknown) => setError(messageOf(cause)),
                )
                .finally(() => setBusy(false));
            }}
          >
            {chosen.length === 0
              ? "Assign"
              : `Assign ${chosen.length} ${chosen.length === 1 ? "exercise" : "exercises"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Add a rater during the study, such as a further pilot rater or an expert who joins late. */
export function AddRaterDialog({
  open,
  onOpenChange,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: Actions;
}) {
  const id = useId();
  const { overview } = actions;
  const [role, setRole] = useState<Role>("pilot");
  const [rater, setRater] = useState(nextId(overview, "pilot"));
  const [deadline, setDeadline] = useState(usualDeadline(overview, "pilot"));
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = overview.raters.some((candidate) => candidate.id === rater);
  const valid = /^[A-Z][A-Z0-9]{0,7}$/.test(rater) && !taken;
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a rater</DialogTitle>
          <DialogDescription>
            The rater gets a personal link, shown once. Keep the mapping from ID to person outside
            the survey.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-120 flex-col gap-5 overflow-y-auto pr-1">
          <FieldSet>
            <FieldLegend variant="label">Role</FieldLegend>
            <RadioGroup
              value={role}
              onValueChange={(value) => {
                const next = value as Role;
                setRole(next);
                setRater(nextId(overview, next));
                setDeadline(usualDeadline(overview, next));
              }}
            >
              {(["pilot", "main", "reserve", "test"] as const).map((option) => (
                <Field key={option} orientation="horizontal">
                  <RadioGroupItem id={`${id}-${option}`} value={option} />
                  <FieldLabel htmlFor={`${id}-${option}`}>{ROLE_LABEL[option]}</FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-id`}>Rater ID</FieldLabel>
              <Input
                id={`${id}-id`}
                value={rater}
                aria-invalid={!valid}
                onChange={(event) => setRater(event.target.value.toUpperCase())}
              />
              {taken ? (
                <FieldError>The study already has a rater {rater}.</FieldError>
              ) : (
                <FieldDescription>A capital letter, then capitals or digits.</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-deadline`}>Deadline</FieldLabel>
              <Input
                id={`${id}-deadline`}
                type="date"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
              />
            </Field>
          </div>
          <ExercisePicker
            exercises={overview.exercises}
            taken={[]}
            suggested={[]}
            chosen={chosen}
            onChosen={setChosen}
          />
          <DialogError error={error} />
        </div>
        <DialogFooter>
          <Cancel disabled={busy} />
          <Button
            disabled={!valid || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              api.admin
                .addRater({
                  id: rater,
                  role,
                  deadline: deadline === "" ? null : deadline,
                  exercises: chosen,
                })
                .then(
                  ({ overview: next, link }) => {
                    actions.accept(next);
                    onOpenChange(false);
                    actions.showLink(rater, link);
                  },
                  (cause: unknown) => setError(messageOf(cause)),
                )
                .finally(() => setBusy(false));
            }}
          >
            Add {rater}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
