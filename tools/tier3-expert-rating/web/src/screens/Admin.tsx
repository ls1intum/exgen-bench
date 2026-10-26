import { type ReactNode, useCallback, useEffect, useId, useState } from "react";

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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { AdminOverview } from "../../../shared/api.ts";
import { api } from "../api.ts";
import { moment } from "../dates.ts";
import { ROLE_NAMES } from "../roles.ts";

/** "3 / 8", or a dash while nothing is planned. */
function ratio(count: number, total: number): string {
  return total === 0 ? "—" : `${count} / ${total}`;
}

/** A table that may scroll sideways, with a fade at its right edge while it is narrower than lg. */
function Scrolling({ children }: { children: ReactNode }) {
  return (
    <div className="relative after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-10 after:bg-linear-to-l after:from-background after:to-transparent lg:after:hidden">
      {children}
    </div>
  );
}

/** A new link revokes the rater's current one, so issuing it asks first. */
function NewLink({ rater, onIssue }: { rater: string; onIssue: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        New link
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Issue a new link for {rater}?</AlertDialogTitle>
          <AlertDialogDescription>
            The current link stops working at once. Send the new link to the rater privately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={() => {
              setBusy(true);
              // The new link, or the error, is shown on the page once the dialog has closed.
              onIssue().finally(() => {
                setBusy(false);
                setOpen(false);
              });
            }}
          >
            Issue the new link
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <p className="m-0 text-xl font-semibold tabular-nums">{value}</p>
      <p className="m-0 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function Reserve({
  overview,
  onOverview,
  onError,
}: {
  overview: AdminOverview;
  onOverview: (next: AdminOverview) => void;
  onError: (error: unknown) => void;
}) {
  const id = useId();
  const reserves = overview.raters.filter((rater) => rater.role === "reserve");
  const [rater, setRater] = useState(reserves[0]?.id ?? "");
  const [kind, setKind] = useState<"tie_breaker" | "backup">("tie_breaker");
  const [replaces, setReplaces] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  if (reserves.length === 0) {
    return <p className="text-sm text-muted-foreground">The study has no reserve raters.</p>;
  }
  const own =
    reserves
      .find((candidate) => candidate.id === rater)
      ?.exercises.map((exercise) => exercise.code) ?? [];
  const suggested =
    kind === "tie_breaker"
      ? overview.exercises
          .filter((exercise) => exercise.agreement === "differ")
          .map((exercise) => exercise.code)
      : (overview.raters.find((candidate) => candidate.id === replaces)?.exercises ?? [])
          .filter((exercise) => !exercise.complete)
          .map((exercise) => exercise.code);
  return (
    <div className="flex flex-col gap-4">
      <FieldSet>
        <FieldLegend variant="label">Reserve rater</FieldLegend>
        <RadioGroup value={rater} onValueChange={(value) => setRater(value as string)}>
          {reserves.map((candidate) => (
            <Field key={candidate.id} orientation="horizontal">
              <RadioGroupItem id={`${id}-${candidate.id}`} value={candidate.id} />
              <FieldLabel htmlFor={`${id}-${candidate.id}`}>
                {candidate.id} ({candidate.status}, {candidate.exercises.length} of 3 assigned)
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">Role</FieldLegend>
        <RadioGroup
          value={kind}
          onValueChange={(value) => setKind(value as "tie_breaker" | "backup")}
        >
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-tie`} value="tie_breaker" />
            <FieldLabel htmlFor={`${id}-tie`}>
              Tie breaker for exercises whose readiness classes differ
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-backup`} value="backup" />
            <FieldLabel htmlFor={`${id}-backup`}>
              Backup for a rater who has not finished
            </FieldLabel>
          </Field>
        </RadioGroup>
      </FieldSet>
      {kind === "backup" && (
        <FieldSet>
          <FieldLegend variant="label">Replaces</FieldLegend>
          <RadioGroup value={replaces} onValueChange={(value) => setReplaces(value as string)}>
            {overview.raters
              .filter((candidate) => candidate.role === "main" && candidate.status !== "Done")
              .map((candidate) => (
                <Field key={candidate.id} orientation="horizontal">
                  <RadioGroupItem id={`${id}-r-${candidate.id}`} value={candidate.id} />
                  <FieldLabel htmlFor={`${id}-r-${candidate.id}`}>
                    {candidate.id} ({candidate.status})
                  </FieldLabel>
                </Field>
              ))}
          </RadioGroup>
        </FieldSet>
      )}
      <FieldSet>
        <FieldLegend variant="label">Exercises (at most three per reserve rater)</FieldLegend>
        <div className="flex flex-wrap gap-4">
          {overview.exercises.map((exercise) => (
            <Field key={exercise.code} orientation="horizontal">
              <Checkbox
                id={`${id}-x-${exercise.code}`}
                disabled={own.includes(exercise.code)}
                checked={chosen.includes(exercise.code)}
                onCheckedChange={(checked) =>
                  setChosen((previous) =>
                    checked
                      ? [...previous, exercise.code]
                      : previous.filter((code) => code !== exercise.code),
                  )
                }
              />
              <FieldLabel htmlFor={`${id}-x-${exercise.code}`}>
                {exercise.code} ({exercise.id}){suggested.includes(exercise.code) && " · suggested"}
              </FieldLabel>
            </Field>
          ))}
        </div>
      </FieldSet>
      <div>
        <Button
          disabled={chosen.length === 0 || (kind === "backup" && replaces === null)}
          onClick={() =>
            api.admin
              .assign({
                rater,
                kind,
                replaces: kind === "backup" ? replaces : null,
                exercises: chosen,
              })
              .then((next) => {
                setChosen([]);
                onOverview(next);
              }, onError)
          }
        >
          Assign
        </Button>
      </div>
    </div>
  );
}

const AGREEMENT: Record<AdminOverview["exercises"][number]["agreement"], string> = {
  pending: "Pending",
  agree: "Agree",
  differ: "Differ: tie break needed",
  resolved: "Settled by a tie breaker",
};

function Export() {
  const id = useId();
  const [roles, setRoles] = useState<string[]>(["main", "reserve"]);
  const query = roles.map((role) => `role=${role}`).join("&");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        {Object.entries(ROLE_NAMES).map(([role, name]) => (
          <Field key={role} orientation="horizontal">
            <Checkbox
              id={`${id}-${role}`}
              checked={roles.includes(role)}
              onCheckedChange={(checked) =>
                setRoles((previous) =>
                  checked ? [...previous, role] : previous.filter((value) => value !== role),
                )
              }
            />
            <FieldLabel htmlFor={`${id}-${role}`}>{name}</FieldLabel>
          </Field>
        ))}
      </div>
      <p className="m-0 text-sm text-muted-foreground">
        A ZIP with tidy CSV tables, the same data as JSON, and a codebook. Remove identifying
        details from free text before publishing.
      </p>
      <div>
        {roles.length > 0 && (
          <a className={buttonVariants()} href={`/api/admin/export.zip?${query}`} download>
            Download the export
          </a>
        )}
      </div>
    </div>
  );
}

/** The study team's view: progress, agreement, reserve assignments, links, deadlines, export. */
export function Admin({ title }: { title: string }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ rater: string; url: string } | null>(null);
  const fail = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );
  useEffect(() => {
    api.admin.overview().then(setOverview, fail);
  }, [fail]);
  if (overview === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const main = overview.raters.filter((rater) => rater.role === "main");
  const planned = overview.exercises.length * overview.study.ratingsPerExercise;
  const submitted = overview.exercises.reduce(
    (sum, exercise) => sum + exercise.readiness.length,
    0,
  );
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <p className="m-0 truncate px-4 py-3 text-sm font-semibold sm:px-6">
          {title} <span className="font-normal text-muted-foreground">· study team</span>
        </p>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-8 sm:px-6">
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Kpi
            value={ratio(main.filter((rater) => rater.status === "Done").length, main.length)}
            label="Main raters done"
          />
          <Kpi value={ratio(submitted, planned)} label="Planned ratings submitted" />
          <Kpi
            value={String(
              overview.exercises.filter((exercise) => exercise.agreement === "differ").length,
            )}
            label="Exercises that need a tie breaker"
          />
          <Kpi
            value={String(overview.raters.filter((rater) => rater.role === "reserve").length)}
            label="Reserve raters"
          />
        </div>
        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-base font-semibold">Raters</h2>
          {link !== null && (
            <Alert>
              <AlertDescription>
                New link for {link.rater}; earlier links stop working. It is shown only now:{" "}
                <code className="font-mono break-all">{link.url}</code>
              </AlertDescription>
            </Alert>
          )}
          <Scrolling>
            <Table containerLabel="Raters">
              <TableHeader>
                <TableRow>
                  <TableHead>Rater</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Exercises</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>Deadline</TableHead>
                  <TableHead>Link</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.raters.map((rater) => (
                  <TableRow key={rater.id}>
                    <TableCell>{rater.id}</TableCell>
                    <TableCell>{rater.role}</TableCell>
                    <TableCell>
                      <Badge variant={rater.status === "Done" ? "secondary" : "outline"}>
                        {rater.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {rater.exercises.length === 0 ? (
                        <span className="text-muted-foreground">None yet</span>
                      ) : (
                        rater.exercises
                          .map((exercise) => `${exercise.code}${exercise.complete ? " ✓" : ""}`)
                          .join(", ")
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="whitespace-nowrap">
                        {rater.lastActivity === null ? "Never" : moment(rater.lastActivity)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="w-40">
                        <Input
                          type="date"
                          aria-label={`Deadline of ${rater.id}`}
                          defaultValue={rater.deadline ?? ""}
                          onChange={(event) => {
                            if (event.target.value !== "") {
                              api.admin
                                .deadline(rater.id, event.target.value)
                                .then(setOverview, fail);
                            }
                          }}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <NewLink
                        rater={rater.id}
                        onIssue={() =>
                          api.admin
                            .link(rater.id)
                            .then(({ link: url }) => setLink({ rater: rater.id, url }), fail)
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Scrolling>
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-base font-semibold">Exercises</h2>
          <Scrolling>
            <Table containerLabel="Exercises">
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Exercise ID</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Ratings</TableHead>
                  <TableHead>Readiness after findings</TableHead>
                  <TableHead>Agreement</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.exercises.map((exercise) => (
                  <TableRow key={exercise.code}>
                    <TableCell>{exercise.code}</TableCell>
                    <TableCell>{exercise.id}</TableCell>
                    <TableCell>{exercise.phase}</TableCell>
                    <TableCell>
                      {exercise.readiness.length} of {exercise.planned}
                    </TableCell>
                    <TableCell>
                      {exercise.readiness.length === 0 ? (
                        <span className="text-muted-foreground">No rating yet</span>
                      ) : (
                        exercise.readiness.join(", ")
                      )}
                      {exercise.tieBreaker.length > 0 &&
                        ` · tie breaker ${exercise.tieBreaker.join(", ")}`}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Scrolling>
        </section>
        <div className="grid gap-10 lg:grid-cols-2">
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-semibold">Assign exercises to a reserve rater</h2>
            <Reserve overview={overview} onOverview={setOverview} onError={fail} />
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-semibold">Export</h2>
            <Export />
          </section>
        </div>
      </main>
    </div>
  );
}
