import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import { sha256 } from "../../../src/core/canonical.ts";
import {
  type Exercise,
  exerciseIdSchema,
  exerciseSchema,
  phaseSchema,
} from "../shared/exercise.ts";
import {
  answerIssues,
  answerSchema,
  type Instrument,
  instrumentSourceSchema,
  resolveInstrument,
} from "../shared/instrument.ts";
import { planProblems } from "../shared/plan.ts";

/**
 * A study: who rates what, with which consent text, built from which generated exercises. The study
 * directory lives with the study's data, outside this repository; the instrument it asks with is
 * the one in this tool.
 */

export const INSTRUMENT_PATH = resolve(import.meta.dir, "../instrument.yaml");

export async function loadInstrument(path = INSTRUMENT_PATH): Promise<Instrument> {
  return resolveInstrument(instrumentSourceSchema.parse(parse(await readFile(path, "utf8"))));
}

const codeSchema = z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/);
const raterIdSchema = z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/);
export const ROLES = ["main", "reserve", "pilot", "test"] as const;
export const roleSchema = z.enum(ROLES);
const isoDate = z.iso.date();

/** A generated candidate in an exgen run, picked by attempt or by case (and system). */
const sourceSchema = z.union([
  z.strictObject({ run: z.string().min(1), attempt: z.string().min(1) }),
  z.strictObject({
    run: z.string().min(1),
    case: z.string().min(1),
    system: z.string().min(1).optional(),
  }),
]);

const exerciseEntrySchema = z.strictObject({
  code: codeSchema,
  phase: phaseSchema,
  source: sourceSchema,
  /** Artemis test cases (`[{ id, testName }]`), for statements that reference tests by ID. */
  test_catalog: z.string().min(1).optional(),
});

export const studySchema = z
  .strictObject({
    schema_version: z.literal("1"),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    title: z.string().min(1),
    contact: z.strictObject({ name: z.string().min(1), email: z.email() }),
    /** The date each role is asked to finish by, shown to raters. */
    deadlines: z.partialRecord(roleSchema, isoDate),
    consent: z.strictObject({
      summary: z.string().min(1),
      details: z.string().min(1),
      statements: z
        .array(z.strictObject({ id: z.string().regex(/^[a-z_]+$/), text: z.string().min(1) }))
        .min(1),
    }),
    ratings_per_exercise: z.number().int().positive(),
    exercises: z.array(exerciseEntrySchema).min(1),
    calibration: exerciseEntrySchema.extend({
      /** The study team's answers to the calibration items, with a short reason each. */
      reference: z.record(
        z.string(),
        z.strictObject({
          answer: answerSchema,
          explanation: z.string().min(1),
        }),
      ),
    }),
    raters: z
      .array(
        z.strictObject({
          id: raterIdSchema,
          role: roleSchema,
          /** Exercise codes in rating order; reserve raters receive theirs during the study. */
          exercises: z.array(codeSchema).default([]),
        }),
      )
      .min(1),
    build: z
      .strictObject({
        /** The java-oracle backend configuration that runs each template's tests. */
        oracle: z.string().min(1),
        /** Accept the fixture backend, which replays recordings: for demos and tests only. */
        allow_fixture_oracle: z.boolean().default(false),
        /** plantuml.jar; without it, diagrams are shown as their PlantUML source. */
        plantuml: z.string().min(1).optional(),
        /** Regular expressions whose matches are removed from everything raters see. */
        blinding: z.array(z.string().min(1)).default([]),
      })
      .optional(),
  })
  .superRefine((study, context) => {
    const codes = [...study.exercises.map((entry) => entry.code), study.calibration.code];
    if (new Set(codes).size !== codes.length) {
      context.addIssue({
        code: "custom",
        message: "exercise codes must be unique",
        path: ["exercises"],
      });
    }
    const raters = study.raters.map((rater) => rater.id);
    if (new Set(raters).size !== raters.length) {
      context.addIssue({ code: "custom", message: "rater IDs must be unique", path: ["raters"] });
    }
    for (const [index, rater] of study.raters.entries()) {
      if (rater.role === "reserve" && rater.exercises.length > 0) {
        context.addIssue({
          code: "custom",
          message: "reserve raters receive their exercises during the study",
          path: ["raters", index, "exercises"],
        });
      }
    }
  });

export type Study = z.infer<typeof studySchema>;
export type Role = z.infer<typeof roleSchema>;

const manifestEntrySchema = z.strictObject({
  code: codeSchema,
  id: exerciseIdSchema,
  phase: phaseSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Study-team only: which generated candidate the exercise was built from. */
  source: z.strictObject({
    run_id: z.string().min(1),
    attempt_id: z.string().min(1),
    case_id: z.string().min(1),
    system_id: z.string().min(1),
    artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  blinding_replacements: z.number().int().nonnegative(),
  diagrams: z.enum(["none", "rendered", "source"]),
});

export const manifestSchema = z.strictObject({
  schema_version: z.literal("1"),
  study_id: z.string().min(1),
  exercises: z.array(manifestEntrySchema),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const EXERCISES_DIRECTORY = "exercises";
export const MANIFEST_FILE = "manifest.json";

export function exercisePath(directory: string, id: string): string {
  return join(directory, EXERCISES_DIRECTORY, `${id}.json`);
}

export async function readStudy(directory: string): Promise<Study> {
  return studySchema.parse(parse(await readFile(join(directory, "study.yaml"), "utf8")));
}

/** Everything the server needs, loaded once and verified against the frozen manifest. */
export interface LoadedStudy {
  directory: string;
  study: Study;
  instrument: Instrument;
  manifest: Manifest;
  /** Exercises by code; codes are visible only to the study team. */
  exercises: Map<string, Exercise>;
  idOf: Map<string, string>;
}

/**
 * Load a built study. Every exercise file must match the digest recorded when it was built, so
 * material a rater sees can never have changed after the study was frozen.
 */
export async function loadStudy(directory: string): Promise<LoadedStudy> {
  const root = resolve(directory);
  const study = await readStudy(root);
  const instrument = await loadInstrument();
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(root, EXERCISES_DIRECTORY, MANIFEST_FILE), "utf8")),
  );
  if (manifest.study_id !== study.id) {
    throw new Error(`the exercises were built for study ${manifest.study_id}, not ${study.id}`);
  }
  const exercises = new Map<string, Exercise>();
  const idOf = new Map<string, string>();
  for (const entry of manifest.exercises) {
    const bytes = await readFile(exercisePath(root, entry.id));
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`exercise ${entry.code} (${entry.id}) changed after it was built`);
    }
    exercises.set(entry.code, exerciseSchema.parse(JSON.parse(bytes.toString("utf8"))));
    idOf.set(entry.code, entry.id);
  }
  const missing = [...study.exercises, study.calibration]
    .map((entry) => entry.code)
    .filter((code) => !exercises.has(code));
  if (missing.length > 0) {
    throw new Error(`exercises not built yet: ${missing.join(", ")}; run exgen survey build`);
  }
  return { directory: root, study, instrument, manifest, exercises, idOf };
}

export interface StudyReport {
  /** Problems that make the study unfit to run. */
  problems: string[];
  /** Deviations a demo or pilot may accept but a formal study should not. */
  warnings: string[];
}

export function checkStudy(
  loaded: Pick<LoadedStudy, "study" | "instrument" | "manifest">,
): StudyReport {
  const { study, instrument, manifest } = loaded;
  const problems: string[] = [];
  const main = study.raters.filter((rater) => rater.role === "main");
  problems.push(...planProblems(study.exercises, main, study.ratings_per_exercise));
  const known = new Set(study.exercises.map((entry) => entry.code));
  for (const rater of study.raters.filter((candidate) => candidate.role !== "main")) {
    const unknown = rater.exercises.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      problems.push(`${rater.id} is assigned unknown exercises: ${unknown.join(", ")}`);
    }
  }
  for (const item of instrument.calibration.items) {
    const reference = study.calibration.reference[item.id];
    if (reference === undefined) {
      problems.push(`the calibration has no reference answer for ${item.id}`);
      continue;
    }
    for (const issue of answerIssues([item], { [item.id]: reference.answer })) {
      problems.push(`the calibration reference answer for ${issue.item} ${issue.message}`);
    }
  }
  const extra = Object.keys(study.calibration.reference).filter(
    (id) => !instrument.calibration.items.some((item) => item.id === id),
  );
  if (extra.length > 0) {
    problems.push(`the calibration answers items it does not ask: ${extra.join(", ")}`);
  }
  const warnings = manifest.exercises
    .filter((entry) => entry.diagrams === "source")
    .map(
      (entry) =>
        `${entry.code} shows its diagrams as PlantUML source; set build.plantuml and rebuild`,
    );
  if (study.build?.allow_fixture_oracle === true) {
    warnings.push(
      "the test overview comes from recorded fixture builds, not from building the exercises",
    );
  }
  return { problems, warnings };
}
