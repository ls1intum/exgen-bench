import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { PublicAttempt, PublicRelease } from "../contracts.ts";
import { outcomeLabel, OUTCOMES } from "./outcomes.ts";
import { configuration, dollars, type PublicCase, type PublicSystem, seconds } from "./release.ts";

type CaseResult = PublicCase["systems"][string];

const ALL = "";

/** Sheet tags ("Sheet 07") when a release has them; otherwise every tag is a group. */
function exerciseGroups(cases: PublicCase[]): { groups: string[]; sheets: boolean } {
  const tags = [...new Set(cases.flatMap((item) => item.tags))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  const sheets = tags.filter((tag) => /^Sheet \d+$/.test(tag));
  return sheets.length > 0 ? { groups: sheets, sheets: true } : { groups: tags, sheets: false };
}

/** Reads a shared selection, dropping a sheet or exercise this release does not have. */
function querySelection(cases: PublicCase[], groups: string[]) {
  const parameters = new URLSearchParams(window.location.search);
  const requestedGroup = parameters.get("sheet") ?? ALL;
  const group = groups.includes(requestedGroup) ? requestedGroup : ALL;
  const requestedExercise = parameters.get("exercise") ?? ALL;
  const exercise = cases.some(
    (item) => item.id === requestedExercise && (group === ALL || item.tags.includes(group)),
  )
    ? requestedExercise
    : ALL;
  return { group, exercise, search: parameters.get("q") ?? "" };
}

function outcomeCounts(results: CaseResult[]): Array<{ label: string; value: number }> {
  return OUTCOMES.map(([key, label]) => ({
    label,
    value: results.reduce((sum, result) => sum + (result[key] ?? 0), 0),
  })).filter((outcome) => outcome.value > 0);
}

/**
 * Narrows the per-exercise results to a sheet, an exercise, or a title search. Counts here are
 * descriptive sums over the selected exercises; campaign estimates and intervals stay unfiltered.
 */
export function ExerciseSection({
  release,
  attempts,
}: {
  release: PublicRelease;
  attempts: PublicAttempt[];
}) {
  const { groups, sheets } = exerciseGroups(release.cases);
  const [initial] = useState(() => querySelection(release.cases, groups));
  const [group, setGroup] = useState(initial.group);
  const [exercise, setExercise] = useState(initial.exercise);
  const [search, setSearch] = useState(initial.search);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    for (const [key, value] of [
      ["sheet", group],
      ["exercise", exercise],
      ["q", search.trim()],
    ] as const) {
      if (value) parameters.set(key, value);
      else parameters.delete(key);
    }
    const query = parameters.toString();
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, [group, exercise, search]);

  const groupLabel = sheets ? "Exercise sheet" : "Exercise group";
  const inGroup = release.cases.filter((item) => group === ALL || item.tags.includes(group));
  const needle = search.trim().toLowerCase();
  const cases = inGroup.filter(
    (item) =>
      (exercise === ALL || item.id === exercise) &&
      `${item.title} ${item.id}`.toLowerCase().includes(needle),
  );
  const results = cases.flatMap((item) => Object.values(item.systems));
  const planned = results.reduce((sum, result) => sum + result.denominator, 0);
  const selected = exercise === ALL ? undefined : cases.find((item) => item.id === exercise);
  const scoped = group !== ALL || exercise !== ALL || needle !== "";

  const reset = () => {
    setGroup(ALL);
    setExercise(ALL);
    setSearch("");
  };

  return (
    <section id="exercises" className="exercises" aria-labelledby="exercises-title">
      <div className="section-heading">
        <div>
          <h2 id="exercises-title">Results by exercise</h2>
          <p>
            Narrow the outcomes to one {sheets ? "sheet" : "group"} or exercise. The selection is
            kept in the address, so a link opens the same view. Campaign estimates above are not
            filtered.
          </p>
        </div>
      </div>
      <div className="exercise-controls">
        {groups.length > 0 && (
          <Field>
            <FieldLabel htmlFor="exercise-group">{groupLabel}</FieldLabel>
            <Select
              items={[
                { value: ALL, label: `All ${sheets ? "sheets" : "groups"}` },
                ...groups.map((tag) => ({ value: tag, label: tag })),
              ]}
              value={group}
              onValueChange={(next) => {
                const value = next ?? ALL;
                setGroup(value);
                if (
                  value !== ALL &&
                  !release.cases.some((item) => item.id === exercise && item.tags.includes(value))
                ) {
                  setExercise(ALL);
                }
              }}
            >
              <SelectTrigger id="exercise-group" className="exercise-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All {sheets ? "sheets" : "groups"}</SelectItem>
                {groups.map((tag) => (
                  <SelectItem key={tag} value={tag}>
                    {tag}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="exercise-choice">Exercise</FieldLabel>
          <Select
            items={[
              { value: ALL, label: "All exercises" },
              ...inGroup.map((item) => ({ value: item.id, label: item.title })),
            ]}
            value={exercise}
            onValueChange={(next) => {
              setExercise(next ?? ALL);
              setSearch("");
            }}
          >
            <SelectTrigger id="exercise-choice" className="exercise-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All exercises</SelectItem>
              {inGroup.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="exercise-search">Search</FieldLabel>
          <Input
            id="exercise-search"
            type="search"
            value={search}
            placeholder="Title or ID"
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        {scoped && (
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw data-icon="inline-start" />
            Reset
          </Button>
        )}
      </div>
      <p className="outcome-note exercise-summary" aria-live="polite">
        <strong>
          {cases.length} of {release.cases.length} exercises
        </strong>
        {cases.length > 0 && (
          <>
            {" "}
            · {planned} planned attempts:{" "}
            {outcomeCounts(results)
              .map((outcome) => `${outcome.label} ${outcome.value}`)
              .join(" · ")}
          </>
        )}
      </p>
      {cases.length === 0 ? (
        <Empty className="exercise-empty">
          <EmptyHeader>
            <EmptyTitle>No exercises match</EmptyTitle>
            <EmptyDescription>
              Change the search or the {sheets ? "sheet" : "group"}, or show every exercise again.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw data-icon="inline-start" />
              Show all exercises
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <BriefTable cases={cases} systems={release.systems} />
      )}
      {selected && (
        <AttemptTable
          exercise={selected}
          systems={release.systems}
          attempts={attempts.filter((attempt) => attempt.case_id === selected.id)}
        />
      )}
    </section>
  );
}

function BriefTable({ cases, systems }: { cases: PublicCase[]; systems: PublicSystem[] }) {
  return (
    <div className={systems.length === 1 ? "brief-table single-system" : "brief-table"}>
      <Table containerLabel="Results by exercise brief">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Exercise brief</TableHead>
            {systems.map((system) => (
              <TableHead key={system.id} scope="col">
                {configuration(system).model} · {configuration(system).approach}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((caseItem) => (
            <TableRow key={caseItem.id}>
              <th scope="row" className="table-row-header">
                <strong>{caseItem.title}</strong>
                <small>{caseItem.tags.join(" · ")}</small>
              </th>
              {systems.map((system) => {
                const result = caseItem.systems[system.id];
                return <TableCell key={system.id}>{result ? caseResult(result) : "—"}</TableCell>;
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function caseResult(result: CaseResult): string {
  const dispositions = outcomeCounts([result]);
  if (result.denominator === 1 && dispositions.length === 1) return dispositions[0]?.label ?? "—";
  return dispositions.map((outcome) => `${outcome.label} ${outcome.value}`).join(" · ");
}

function AttemptTable({
  exercise,
  systems,
  attempts,
}: {
  exercise: PublicCase;
  systems: PublicSystem[];
  attempts: PublicAttempt[];
}) {
  const order = new Map(systems.map((system, index) => [system.id, index]));
  const names = new Map(
    systems.map((system) => [
      system.id,
      `${configuration(system).model} · ${configuration(system).approach}`,
    ]),
  );
  const rows = attempts.toSorted(
    (left, right) =>
      (order.get(left.system_id) ?? 0) - (order.get(right.system_id) ?? 0) ||
      left.replicate - right.replicate,
  );
  return (
    <figure className="attempt-table">
      <figcaption>
        <h3>Attempts for {exercise.title}</h3>
        <p>Missing measurements are shown as not recorded, never as zero.</p>
      </figcaption>
      {rows.length === 0 ? (
        <p className="outcome-note">No attempt records are published for this exercise.</p>
      ) : (
        <Table containerLabel={`Attempts for ${exercise.title}`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Configuration</TableHead>
              <TableHead scope="col">Attempt</TableHead>
              <TableHead scope="col">Outcome</TableHead>
              <TableHead scope="col">Generation time</TableHead>
              <TableHead scope="col">Tokens</TableHead>
              <TableHead scope="col">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((attempt) => (
              <TableRow key={attempt.observation_id}>
                <th scope="row" className="table-row-header">
                  {names.get(attempt.system_id) ?? attempt.system_id}
                </th>
                <TableCell>{attempt.replicate}</TableCell>
                <TableCell>{outcomeLabel(attempt.outcome)}</TableCell>
                <TableCell>
                  {attempt.generation_duration_seconds === undefined
                    ? "not recorded"
                    : seconds(attempt.generation_duration_seconds)}
                </TableCell>
                <TableCell>
                  {attempt.total_tokens === undefined
                    ? "not recorded"
                    : attempt.total_tokens.toLocaleString("en-US")}
                </TableCell>
                <TableCell>
                  {attempt.cost_usd === undefined ? "not recorded" : dollars(attempt.cost_usd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </figure>
  );
}
