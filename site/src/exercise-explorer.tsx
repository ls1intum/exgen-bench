import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PublicAttempt, PublicRelease, PublicScore } from "../contracts.ts";
import { formatValue } from "./evaluation.tsx";
import { OUTCOMES, outcomeLabel } from "./outcomes.ts";
import { type PublicCase, type PublicSystem, configuration, seconds } from "./release.ts";

/** A descriptive slice only: never reuse campaign estimates for a subset. */
export function ExerciseExplorer({
  release,
  attempts,
  scores,
}: {
  release: PublicRelease;
  attempts: PublicAttempt[];
  scores: PublicScore[];
}) {
  const tags = [...new Set(release.cases.flatMap((item) => item.tags))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const sheets = tags.filter((tag) => /^Sheet \d+$/.test(tag));
  const groups = sheets.length ? sheets : tags;
  const parameters = new URLSearchParams(window.location.search);
  const [group, setGroup] = useState(() => {
    const requested = parameters.get("sheet") ?? "";
    return groups.includes(requested) ? requested : "";
  });
  const [query, setQuery] = useState(() => parameters.get("q") ?? "");
  const [exercise, setExercise] = useState(() => {
    const requested = parameters.get("exercise") ?? "";
    return release.cases.some(
      (item) => item.id === requested && (!group || item.tags.includes(group)),
    )
      ? requested
      : "";
  });
  const grouped = release.cases.filter((item) => !group || item.tags.includes(group));
  const cases = grouped.filter(
    (item) =>
      (!exercise || item.id === exercise) &&
      `${item.title} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const caseIds = new Set(cases.map((item) => item.id));
  const visibleAttempts = attempts.filter((attempt) => caseIds.has(attempt.case_id));
  const scoped = Boolean(group || exercise || query);
  const planned = cases.reduce(
    (sum, item) =>
      sum + Object.values(item.systems).reduce((count, result) => count + result.denominator, 0),
    0,
  );
  const accepted = cases.reduce(
    (sum, item) =>
      sum + Object.values(item.systems).reduce((count, result) => count + result.accepted, 0),
    0,
  );
  const notStarted = cases.reduce(
    (sum, item) =>
      sum +
      Object.values(item.systems).reduce((count, result) => count + (result.not_started ?? 0), 0),
    0,
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    for (const [key, value] of [
      ["sheet", group],
      ["exercise", exercise],
      ["q", query],
    ] as const) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", url);
  }, [group, exercise, query]);

  return (
    <section className="exercise-explorer" aria-labelledby="explorer-title" id="exercises">
      <div className="section-heading">
        <div>
          <h2 id="explorer-title">Explore exercise results</h2>
          <p>Choose a sheet, then an exercise. Your selection is saved in the URL for sharing.</p>
        </div>
      </div>
      <div className="exercise-controls">
        {groups.length > 0 && (
          <label>
            {sheets.length ? "Exercise sheet" : "Exercise group"}
            <select
              aria-label={sheets.length ? "Exercise sheet" : "Exercise group"}
              value={group}
              onChange={(event) => {
                setGroup(event.target.value);
                setExercise("");
                setQuery("");
              }}
            >
              <option value="">
                All {sheets.length ? "sheets" : "groups"} ({release.cases.length} exercises)
              </option>
              {groups.map((tag) => (
                <option key={tag} value={tag}>
                  {tag} ({release.cases.filter((item) => item.tags.includes(tag)).length} exercises)
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Exercise
          <select
            aria-label="Exercise"
            value={exercise}
            onChange={(event) => {
              setExercise(event.target.value);
              setQuery("");
            }}
          >
            <option value="">All exercises in selection</option>
            {grouped.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search exercises
          <input
            type="search"
            value={query}
            placeholder="Title or case ID…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {scoped && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setGroup("");
              setExercise("");
              setQuery("");
            }}
          >
            <RotateCcw data-icon="inline-start" />
            Reset selection
          </Button>
        )}
      </div>
      <p className="outcome-note" role="status" aria-label="Exercise selection">
        Showing{" "}
        <strong>
          {cases.length} of {release.cases.length} exercises
        </strong>
        {group ? ` · ${group}` : " · All exercises"}. Only the explorer below is filtered; campaign
        statistics remain unchanged.
      </p>
      <dl className="exercise-counts" aria-label="Selected exercise outcomes">
        <div>
          <dt>Planned attempts</dt>
          <dd>{planned}</dd>
        </div>
        <div>
          <dt>Strictly accepted</dt>
          <dd>{accepted}</dd>
        </div>
        <div>
          <dt>Other outcomes</dt>
          <dd>{planned - accepted - notStarted}</dd>
        </div>
        <div>
          <dt>Not started</dt>
          <dd>{notStarted}</dd>
        </div>
      </dl>
      <p className="outcome-note">
        Descriptive counts across all systems, including attempts without candidates. No subset
        confidence interval is estimated. Missing measurements are not zero.
      </p>
      {cases.length === 0 ? (
        <p className="exercise-empty">
          No exercises match this selection. Clear the search or reset the selection.
        </p>
      ) : (
        <>
          <BriefTable cases={cases} systems={release.systems} />
          <div className="exercise-details">
            {cases.map((item) => {
              const itemAttempts = visibleAttempts.filter((attempt) => attempt.case_id === item.id);
              return (
                <details key={item.id} open={exercise === item.id || undefined}>
                  <summary>{item.title} — attempt details and measurements</summary>
                  {itemAttempts.length === 0 && (
                    <p>
                      No attempt records are published for this exercise. Planned outcomes remain in
                      the table above.
                    </p>
                  )}
                  {itemAttempts.map((attempt) => {
                    const measurements = scores.filter(
                      (score) => score.observation_id === attempt.observation_id,
                    );
                    return (
                      <article key={attempt.observation_id}>
                        <h3>
                          {release.systems.find((system) => system.id === attempt.system_id)
                            ?.name ?? attempt.system_id}{" "}
                          · Attempt {attempt.replicate}
                        </h3>
                        <p>
                          {outcomeLabel(attempt.outcome)} · Time:{" "}
                          {attempt.generation_duration_seconds === undefined
                            ? "not recorded"
                            : seconds(attempt.generation_duration_seconds)}{" "}
                          · Tokens:{" "}
                          {attempt.total_tokens === undefined
                            ? "not recorded"
                            : attempt.total_tokens.toLocaleString("en-US")}
                        </p>
                        {measurements.length === 0 ? (
                          <p>No evaluator measurements published for this attempt.</p>
                        ) : (
                          <Table
                            containerLabel={`Measurements for ${item.title}, ${attempt.system_id}, attempt ${attempt.replicate}`}
                          >
                            <TableHeader>
                              <TableRow>
                                <TableHead>Evaluator / metric</TableHead>
                                <TableHead>Value</TableHead>
                                <TableHead>Status</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {measurements.map((score) => {
                                const card = release.metrics.find(
                                  (metric) =>
                                    metric.id === score.metric_id &&
                                    metric.version === score.metric_version,
                                );
                                return (
                                  <TableRow
                                    key={`${score.evaluator_id}/${score.metric_id}/${score.metric_version}`}
                                  >
                                    <th scope="row" className="table-row-header">
                                      {score.evaluator_id} / {card?.name ?? score.metric_id}
                                    </th>
                                    <TableCell>
                                      {score.score_status === "ok"
                                        ? card
                                          ? formatValue(card, score.value)
                                          : String(score.value)
                                        : "—"}
                                    </TableCell>
                                    <TableCell>{score.score_status.replaceAll("_", " ")}</TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        )}
                      </article>
                    );
                  })}
                </details>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function BriefTable({ cases, systems }: { cases: PublicCase[]; systems: PublicSystem[] }) {
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

function caseResult(result: PublicCase["systems"][string]): string {
  const dispositions = OUTCOMES.map(([key, label]) => ({
    label,
    value: result[key] ?? 0,
  })).filter((outcome) => outcome.value > 0);
  if (result.denominator === 1 && dispositions.length === 1) return dispositions[0]?.label ?? "—";
  return dispositions.map((outcome) => `${outcome.label} ${outcome.value}`).join(" · ");
}
