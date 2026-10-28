import { CheckIcon, EllipsisIcon, UserPlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { api } from "../../api.ts";
import { ago, moment } from "../../dates.ts";
import { type Actions, AddRaterDialog, AssignDialog, Confirm, messageOf } from "./dialogs.tsx";
import { inactiveDays, KIND_LABEL, overdue, type Rater, ROLE_LABEL } from "./model.ts";
import { Scrolling } from "./Scrolling.tsx";

/** One assignment: its exercise, how many parts are done, and why the rater rates it. */
function Assignment({ exercise }: { exercise: Rater["exercises"][number] }) {
  const why =
    exercise.kind === "planned"
      ? null
      : exercise.kind === "backup"
        ? `${KIND_LABEL.backup} for ${exercise.replaces}`
        : KIND_LABEL[exercise.kind];
  return (
    <li className="flex items-center gap-1.5">
      <Badge variant={exercise.complete ? "secondary" : "outline"}>
        {exercise.complete && <CheckIcon data-icon="inline-start" />}
        {exercise.code}
        {!exercise.complete && <span className="text-muted-foreground">{exercise.parts}/4</span>}
      </Badge>
      {why !== null && <span className="text-xs text-muted-foreground">{why}</span>}
    </li>
  );
}

/** Remove assignments the rater has not started, such as after a dropout or a wrong assignment. */
function RemoveDialog({
  open,
  onOpenChange,
  rater,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rater: Rater;
  actions: Actions;
}) {
  const id = useId();
  const removable = rater.exercises.filter((exercise) => !exercise.started);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove assignments of {rater.id}</DialogTitle>
          <DialogDescription>
            Only exercises the rater has not started. The change is logged, and an exercise can be
            assigned again.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {removable.map((exercise) => (
            <Field key={exercise.code} orientation="horizontal">
              <Checkbox
                id={`${id}-${exercise.code}`}
                checked={chosen.includes(exercise.code)}
                onCheckedChange={(checked) =>
                  setChosen((previous) =>
                    checked
                      ? [...previous, exercise.code]
                      : previous.filter((code) => code !== exercise.code),
                  )
                }
              />
              <FieldLabel htmlFor={`${id}-${exercise.code}`}>
                {exercise.code}
                <span className="font-normal text-muted-foreground">
                  {KIND_LABEL[exercise.kind]}
                </span>
              </FieldLabel>
            </Field>
          ))}
        </FieldGroup>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={chosen.length === 0 || busy}
            onClick={() => {
              setBusy(true);
              chosen
                .reduce<Promise<unknown>>(
                  (previous, code) =>
                    previous.then(() => api.admin.unassign(rater.id, code).then(actions.accept)),
                  Promise.resolve(),
                )
                .then(
                  () => {
                    setChosen([]);
                    onOpenChange(false);
                  },
                  (cause: unknown) => setError(messageOf(cause)),
                )
                .finally(() => setBusy(false));
            }}
          >
            {chosen.length === 0 ? "Remove" : `Remove ${chosen.join(", ")}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a row's menu opens: one dialog at a time. */
type Open = "assign" | "remove" | "link" | "revoke" | "withdraw" | null;

function RaterRow({ rater, actions }: { rater: Rater; actions: Actions }) {
  const [open, setOpen] = useState<Open>(null);
  const late = overdue(rater);
  const idle = inactiveDays(rater);
  const percent =
    rater.progress.total === 0 ? 0 : (100 * rater.progress.done) / rater.progress.total;
  return (
    <TableRow>
      <TableCell className="sticky left-0 z-10 bg-background">
        <div className="flex flex-col">
          <span className="font-medium">{rater.id}</span>
          <span className="text-xs text-muted-foreground">
            {ROLE_LABEL[rater.role]}
            {rater.added && " · added"}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex w-44 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm">{rater.status}</span>
            {late && <Badge variant="destructive">Overdue</Badge>}
            {idle !== null && (
              <Badge variant="destructive">
                No activity for {idle} {idle === 1 ? "day" : "days"}
              </Badge>
            )}
          </div>
          <Progress value={percent} aria-label={`Progress of ${rater.id}`} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {rater.progress.done} of {rater.progress.total} steps done
          </span>
        </div>
      </TableCell>
      <TableCell>
        {rater.exercises.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {rater.exercises.map((exercise) => (
              <Assignment key={exercise.code} exercise={exercise} />
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell>
        <span className="tabular-nums">{rater.minutes === 0 ? "—" : `${rater.minutes} min`}</span>
      </TableCell>
      <TableCell>
        {rater.lastActivity === null ? (
          <span className="text-muted-foreground">Never</span>
        ) : (
          <span className="whitespace-nowrap">
            <Tooltip>
              <TooltipTrigger render={<span />}>{ago(rater.lastActivity)}</TooltipTrigger>
              <TooltipContent>{moment(rater.lastActivity)}</TooltipContent>
            </Tooltip>
          </span>
        )}
      </TableCell>
      <TableCell>
        <div className="w-40">
          {/* Saved when the field is left, so typing a date does not log every keystroke. */}
          <Input
            key={rater.deadline ?? ""}
            type="date"
            aria-label={`Deadline of ${rater.id}`}
            disabled={rater.withdrawn}
            defaultValue={rater.deadline ?? ""}
            onBlur={(event) => {
              const value = event.target.value;
              if (
                /^\d{4}-\d{2}-\d{2}$/.test(value) &&
                value >= "2000-01-01" &&
                value !== rater.deadline
              ) {
                api.admin.deadline(rater.id, value).then(actions.accept, actions.fail);
              }
            }}
          />
        </div>
      </TableCell>
      <TableCell>
        {rater.link ? (
          <Badge variant="secondary">Active</Badge>
        ) : (
          <span className="text-muted-foreground">{rater.withdrawn ? "Withdrawn" : "No link"}</span>
        )}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${rater.id}`} />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem disabled={rater.withdrawn} onClick={() => setOpen("assign")}>
              Assign exercises…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={rater.withdrawn || rater.exercises.every((exercise) => exercise.started)}
              onClick={() => setOpen("remove")}
            >
              Remove assignments…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={rater.withdrawn} onClick={() => setOpen("link")}>
              New link…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!rater.link} onClick={() => setOpen("revoke")}>
              Revoke link…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={rater.withdrawn}
              onClick={() => setOpen("withdraw")}
            >
              Withdraw…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Mounted only while open, so each opening starts from a clean form. */}
        {open === "assign" && (
          <AssignDialog
            open
            onOpenChange={(next) => setOpen(next ? "assign" : null)}
            actions={actions}
            rater={rater}
          />
        )}
        {open === "remove" && (
          <RemoveDialog
            open
            onOpenChange={(next) => setOpen(next ? "remove" : null)}
            rater={rater}
            actions={actions}
          />
        )}
        <Confirm
          open={open === "link"}
          onOpenChange={(next) => setOpen(next ? "link" : null)}
          title={`Issue a new link for ${rater.id}?`}
          description="The current link stops working at once. The new one is shown once; send it to the rater privately."
          action="Issue the new link"
          onConfirm={() =>
            api.admin
              .link(rater.id)
              .then(({ link }) => actions.showLink(rater.id, link), actions.fail)
          }
        />
        <Confirm
          open={open === "revoke"}
          onOpenChange={(next) => setOpen(next ? "revoke" : null)}
          title={`Revoke the link of ${rater.id}?`}
          description="The rater can no longer open the survey until you issue a new link. Their answers stay."
          action="Revoke"
          onConfirm={() => api.admin.revoke(rater.id).then(actions.accept, actions.fail)}
        />
        <Confirm
          open={open === "withdraw"}
          onOpenChange={(next) => setOpen(next ? "withdraw" : null)}
          title={`Withdraw ${rater.id} and delete their answers?`}
          description={
            <>
              Only at the rater's request. Every answer of {rater.id} is deleted for good and their
              link stops working; the rater stays in the list as withdrawn. To end a rater's
              participation and keep their answers, revoke the link instead.
            </>
          }
          action="Withdraw and delete"
          destructive
          onConfirm={() => api.admin.withdraw(rater.id).then(actions.accept, actions.fail)}
        />
      </TableCell>
    </TableRow>
  );
}

export function Raters({ actions }: { actions: Actions }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm text-muted-foreground">
          Each row's menu assigns and removes exercises, and manages the rater's link. Every change
          is logged.
        </p>
        <Button onClick={() => setAdding(true)}>
          <UserPlusIcon data-icon="inline-start" />
          Add rater
        </Button>
      </div>
      <Scrolling>
        <Table containerLabel="Raters">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-background">Rater</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Exercises</TableHead>
              <TableHead>Rating time</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead>Deadline</TableHead>
              <TableHead>Link</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {actions.overview.raters.map((rater) => (
              <RaterRow key={rater.id} rater={rater} actions={actions} />
            ))}
          </TableBody>
        </Table>
      </Scrolling>
      {adding && <AddRaterDialog open onOpenChange={setAdding} actions={actions} />}
    </div>
  );
}
