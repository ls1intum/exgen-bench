import { strToU8, zipSync } from "fflate";

import { toCsv } from "../../../src/export/serialize.ts";
import { PARTS, stepKey } from "../shared/flow.ts";
import type { Item, SectionAnswers } from "../shared/instrument.ts";
import type { StepRow, SurveyStore } from "./store.ts";
import type { LoadedStudy } from "./study.ts";

/**
 * The study's results as tidy tables: one row per rating and one column per item, plus one table
 * per questionnaire and a codebook generated from the instrument, so every column is documented by
 * the same text the raters read. Raters appear only under their pseudonymous IDs.
 */

interface Column {
  name: string;
  description: string;
  value: (answers: SectionAnswers) => string | number | undefined;
}

function columnsFor(items: Item[]): Column[] {
  return items.flatMap((item): Column[] => {
    if (item.kind === "text") {
      return [
        { name: item.id, description: item.prompt, value: (answers) => answers[item.id]?.text },
      ];
    }
    const options = item.options.map((option) => `${option.value} = ${option.label}`).join("; ");
    const main: Column =
      item.kind === "multi"
        ? {
            name: item.id,
            description: `${item.prompt} Values, separated by ";": ${options}.`,
            value: (answers) => answers[item.id]?.values?.join(";"),
          }
        : {
            name: item.id,
            description: `${item.prompt} Values: ${options}.`,
            value: (answers) => answers[item.id]?.value,
          };
    const details = item.options.flatMap((option) =>
      option.detail === undefined ? [] : [option.detail],
    );
    const choices = details.flatMap((detail) => detail.choices ?? []);
    return [
      main,
      ...(choices.length > 0
        ? [
            {
              name: `${item.id}_choice`,
              description: `Follow-up of ${item.id}: ${choices.map((choice) => `${choice.value} = ${choice.label}`).join("; ")}.`,
              value: (answers: SectionAnswers) => answers[item.id]?.choice,
            },
          ]
        : []),
      ...(details.length > 0
        ? [
            {
              name: `${item.id}_text`,
              description: `Free text of ${item.id}: ${[...new Set(details.map((detail) => detail.label))].join(" / ")}.`,
              value: (answers: SectionAnswers) => answers[item.id]?.text,
            },
          ]
        : []),
    ];
  });
}

const parse = (row: StepRow | undefined): SectionAnswers =>
  row?.answers == null ? {} : (JSON.parse(row.answers) as SectionAnswers);

function seconds(row: StepRow | undefined): number | undefined {
  return row?.opened_at == null || row.submitted_at == null
    ? undefined
    : Math.round((Date.parse(row.submitted_at) - Date.parse(row.opened_at)) / 1000);
}

interface Table {
  file: string;
  description: string;
  columns: Array<{ name: string; description: string }>;
  rows: Array<Record<string, unknown>>;
}

function tables(loaded: LoadedStudy, store: SurveyStore, roles: readonly string[]): Table[] {
  const { study, instrument } = loaded;
  const raters = store.raters().filter((rater) => roles.includes(rater.role));
  const steps = store.steps();
  const stepOf = (raterId: string, key: string) =>
    steps.find((row) => row.rater_id === raterId && row.step === key);
  const raterColumns = [
    { name: "rater_id", description: "Pseudonymous rater ID." },
    { name: "role", description: "main, reserve, pilot, or test." },
  ];
  const section = (file: string, description: string, key: string, items: Item[]): Table => {
    const columns = columnsFor(items);
    return {
      file,
      description,
      columns: [
        ...raterColumns,
        { name: "submitted_at", description: "When the answers were submitted (UTC)." },
        ...columns,
      ],
      rows: raters
        .filter((rater) => stepOf(rater.id, key)?.submitted_at != null)
        .map((rater) => {
          const row = stepOf(rater.id, key);
          const answers = parse(row);
          return {
            rater_id: rater.id,
            role: rater.role,
            submitted_at: row?.submitted_at,
            ...Object.fromEntries(columns.map((column) => [column.name, column.value(answers)])),
          };
        }),
    };
  };

  const questionnaire = instrument.questionnaire.parts.flatMap((part) =>
    columnsFor(part.items).map((column) => ({ ...column, part: part.id })),
  );
  const ratingColumns = [
    ...raterColumns,
    {
      name: "exercise_code",
      description: "The study team's code of the exercise (brief and phase).",
    },
    { name: "exercise_id", description: "The random ID raters saw." },
    {
      name: "exercise_sha256",
      description: "SHA-256 of the built exercise file the rater was shown, from manifest.json.",
    },
    { name: "phase", description: "Course phase of the brief: early, middle, or late." },
    { name: "position", description: "Position of the exercise in the rater's session, from 1." },
    { name: "assignment", description: "planned, backup, or tie_breaker." },
    { name: "replaces", description: "For a backup assignment, the rater it replaces." },
    {
      name: "instrument_version",
      description: "Version of the instrument the answers were given with.",
    },
    { name: "complete", description: "Whether all four parts were submitted." },
    ...PARTS.map((part) => ({
      name: `seconds_${part}`,
      description: `Seconds between opening Part ${part}'s material and submitting its answers.`,
    })),
    ...questionnaire.map((column) => ({
      name: column.name,
      description: `Part ${column.part}. ${column.description}`,
    })),
  ];
  const ratings = raters.flatMap((rater) =>
    store
      .assignments(rater.id)
      .filter(
        (assignment) =>
          stepOf(rater.id, stepKey({ kind: "part", position: assignment.position, part: "A" }))
            ?.submitted_at != null,
      )
      .map((assignment) => {
        const rows = Object.fromEntries(
          PARTS.map((part) => [
            part,
            stepOf(rater.id, stepKey({ kind: "part", position: assignment.position, part })),
          ]),
        );
        return {
          rater_id: rater.id,
          role: rater.role,
          exercise_code: assignment.exercise,
          exercise_id: loaded.idOf.get(assignment.exercise),
          exercise_sha256: loaded.manifest.exercises.find(
            (entry) => entry.code === assignment.exercise,
          )?.sha256,
          phase: study.exercises.find((entry) => entry.code === assignment.exercise)?.phase,
          position: assignment.position,
          assignment: assignment.kind,
          replaces: assignment.replaces ?? undefined,
          instrument_version: rows.A?.instrument_version,
          complete: PARTS.every((part) => rows[part]?.submitted_at != null),
          ...Object.fromEntries(PARTS.map((part) => [`seconds_${part}`, seconds(rows[part])])),
          ...Object.fromEntries(
            questionnaire.map((column) => [column.name, column.value(parse(rows[column.part]))]),
          ),
        };
      }),
  );

  return [
    {
      file: "raters.csv",
      description: "One row per rater: consent and deadline.",
      columns: [
        ...raterColumns,
        { name: "consented_at", description: "When the rater gave consent (UTC)." },
        { name: "declined_at", description: "When the rater declined to take part (UTC)." },
        {
          name: "withdrawn_at",
          description:
            "When the rater withdrew; their answers were deleted at their request (UTC).",
        },
        { name: "deadline", description: "The date the rater was asked to finish by." },
      ],
      rows: raters.map((rater) => ({
        rater_id: rater.id,
        role: rater.role,
        consented_at: stepOf(rater.id, "consent")?.submitted_at ?? undefined,
        declined_at: rater.declined_at ?? undefined,
        withdrawn_at: rater.withdrawn_at ?? undefined,
        deadline: rater.deadline ?? undefined,
      })),
    },
    {
      file: "ratings.csv",
      description: "One row per rating of an exercise, with one column per questionnaire item.",
      columns: ratingColumns,
      rows: ratings,
    },
    section(
      "background.csv",
      "One row per rater: the background questionnaire.",
      "background",
      instrument.background.items,
    ),
    section(
      "calibration.csv",
      "One row per rater: answers to the practice exercise, which is not analysed.",
      "calibration",
      instrument.calibration.items,
    ),
    section("exit.csv", "One row per rater: the final survey.", "exit", instrument.exit.items),
    {
      file: "events.csv",
      description: "Which material views and files raters opened, in order.",
      columns: [
        ...raterColumns,
        { name: "step", description: "The step the event belongs to, such as exercise-1-B." },
        { name: "type", description: "view: a material tab; file: a template file." },
        { name: "target", description: "The tab or file path." },
        { name: "at", description: "When the server received the event (UTC)." },
      ],
      rows: store
        .events()
        .filter((event) => raters.some((rater) => rater.id === event.rater_id))
        .map((event) => ({
          ...event,
          role: raters.find((rater) => rater.id === event.rater_id)?.role,
        })),
    },
  ];
}

function codebook(loaded: LoadedStudy, all: Table[], roles: readonly string[]): string {
  const sections = all.map(
    (table) =>
      `## ${table.file}\n\n${table.description}\n\n| Column | Meaning |\n| --- | --- |\n${table.columns
        .map(
          (column) =>
            `| \`${column.name}\` | ${column.description.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
        )
        .join("\n")}\n`,
  );
  return `# ${loaded.study.title}: data export

Study \`${loaded.study.id}\`, instrument version ${loaded.instrument.version}, roles ${roles.join(", ")}.
Raters appear only under pseudonymous IDs. Before publishing, remove identifying details from free
text and coarsen the background answers. \`data.json\` holds the same answers with the instrument.
In the CSV files, a cell that starts with \`=\`, \`+\`, \`-\`, \`@\`, a tab or a carriage return is
prefixed with \`'\`, so that spreadsheets do not run it as a formula; \`data.json\` keeps it as written.

${sections.join("\n")}`;
}

/** The export the study team downloads: tidy CSV tables, the same data as JSON, and a codebook. */
export function exportArchive(
  loaded: LoadedStudy,
  store: SurveyStore,
  roles: readonly string[],
): Uint8Array {
  const all = tables(loaded, store, roles);
  const files: Record<string, Uint8Array> = {
    "CODEBOOK.md": strToU8(codebook(loaded, all, roles)),
    "data.json": strToU8(
      `${JSON.stringify(
        {
          study: {
            id: loaded.study.id,
            title: loaded.study.title,
            ratings_per_exercise: loaded.study.ratings_per_exercise,
            exercises: loaded.study.exercises.map((entry) => ({
              code: entry.code,
              phase: entry.phase,
              id: loaded.idOf.get(entry.code),
              sha256: loaded.manifest.exercises.find((built) => built.code === entry.code)?.sha256,
            })),
          },
          instrument: loaded.instrument,
          tables: Object.fromEntries(
            all.map((table) => [table.file.replace(/\.csv$/, ""), table.rows]),
          ),
        },
        null,
        2,
      )}\n`,
    ),
  };
  for (const table of all) {
    files[table.file] = strToU8(
      toCsv(
        table.columns.map((column) => column.name),
        table.rows,
      ),
    );
  }
  return zipSync(files);
}

/** A rater's own answers, which they may download at the end of the session. */
export function raterExport(loaded: LoadedStudy, store: SurveyStore, raterId: string) {
  return {
    study: loaded.study.title,
    rater: raterId,
    steps: store
      .steps(raterId)
      .filter((row) => row.submitted_at !== null)
      .map((row) => ({ step: row.step, submitted_at: row.submitted_at, answers: parse(row) })),
  };
}
