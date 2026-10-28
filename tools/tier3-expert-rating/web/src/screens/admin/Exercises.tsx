import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { type Actions, AssignDialog } from "./dialogs.tsx";
import type { Exercise } from "./model.ts";
import { Scrolling } from "./Scrolling.tsx";

const AGREEMENT: Record<Exercise["agreement"], string> = {
  pending: "Pending",
  agree: "Agree",
  differ: "Differ",
  resolved: "Settled by a tie breaker",
};

function ExerciseRow({ exercise, actions }: { exercise: Exercise; actions: Actions }) {
  const [assigning, setAssigning] = useState(false);
  const counted = exercise.readiness.length + exercise.tieBreaker.length;
  const other = Math.max(0, exercise.ratings - counted);
  return (
    <TableRow>
      <TableCell className="sticky left-0 z-10 bg-background">
        <div className="flex flex-col">
          <span className="font-medium">{exercise.code}</span>
          <span className="text-xs text-muted-foreground">
            {exercise.phase} · {exercise.id}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <span className="tabular-nums">
          {exercise.readiness.length} of {exercise.planned}
        </span>
      </TableCell>
      <TableCell>
        <span className="tabular-nums">{other === 0 ? "—" : other}</span>
      </TableCell>
      <TableCell>
        <span className="tabular-nums">
          {exercise.inProgress === 0 ? "—" : exercise.inProgress}
        </span>
      </TableCell>
      <TableCell>
        {exercise.readiness.length === 0 ? (
          <span className="text-muted-foreground">None yet</span>
        ) : (
          <span className="tabular-nums">{exercise.readiness.join(", ")}</span>
        )}
        {exercise.tieBreaker.length > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · tie breaker {exercise.tieBreaker.join(", ")}
          </span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              exercise.agreement === "differ"
                ? "destructive"
                : exercise.agreement === "pending"
                  ? "outline"
                  : "secondary"
            }
          >
            {AGREEMENT[exercise.agreement]}
          </Badge>
          {exercise.agreement === "differ" && (
            <Button variant="outline" size="sm" onClick={() => setAssigning(true)}>
              Assign a tie breaker
            </Button>
          )}
        </div>
        {assigning && (
          <AssignDialog
            open
            onOpenChange={setAssigning}
            actions={actions}
            kind="tie_breaker"
            exercises={[exercise.code]}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

export function Exercises({ actions }: { actions: Actions }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 max-w-prose text-sm text-muted-foreground">
        Planned ratings are those of main raters and their backups, which the analysis uses. Two
        readiness ratings agree when both fall into the same class: ready (4–5), usable (3), or not
        usable (1–2).
      </p>
      <Scrolling>
        <Table containerLabel="Exercises">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-background">Exercise</TableHead>
              <TableHead>Planned ratings</TableHead>
              <TableHead>Other ratings</TableHead>
              <TableHead>Under way</TableHead>
              <TableHead>Readiness after findings</TableHead>
              <TableHead>Agreement</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {actions.overview.exercises.map((exercise) => (
              <ExerciseRow key={exercise.code} exercise={exercise} actions={actions} />
            ))}
          </TableBody>
        </Table>
      </Scrolling>
    </div>
  );
}
