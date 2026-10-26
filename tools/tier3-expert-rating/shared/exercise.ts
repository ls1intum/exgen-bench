import { z } from "zod";

import type { Material } from "./instrument.ts";

/**
 * A study exercise: everything a rater may see of one generated exercise, built once from a frozen
 * candidate and never edited afterwards. Provenance (run, attempt, model) stays in the study team's
 * manifest; nothing in this document identifies the generator.
 */

export const exerciseIdSchema = z.string().regex(/^[A-Z0-9]{4}$/);
export const phaseSchema = z.enum(["early", "middle", "late"]);

const fileSchema = z.strictObject({ path: z.string().min(1), content: z.string() });

const diffLineSchema = z.strictObject({
  kind: z.enum(["context", "added", "removed"]),
  text: z.string(),
  /** Line number in the template, absent for an added line. */
  old: z.number().int().positive().optional(),
  /** Line number in the solution, absent for a removed line. */
  new: z.number().int().positive().optional(),
});

const diffFileSchema = z.strictObject({
  path: z.string().min(1),
  change: z.enum(["added", "modified", "removed"]),
  hunks: z.array(z.strictObject({ header: z.string(), lines: z.array(diffLineSchema) })),
});

const testSchema = z.strictObject({
  name: z.string().min(1),
  /** What a student sees when the test fails. */
  message: z.string(),
  /** True when the test has no message of its own and students see only the assertion text. */
  generic: z.boolean(),
});

const findingSchema = z.strictObject({
  id: z.string().regex(/^F[0-9]+$/),
  severity: z.enum(["warning", "info"]),
  category: z.string().min(1),
  title: z.string().min(1),
  detail: z.string(),
});

export const exerciseSchema = z.strictObject({
  schema_version: z.literal("1"),
  id: exerciseIdSchema,
  phase: phaseSchema,
  brief: z.string().min(1),
  /** The problem statement; task markers keep their title and lose their test list. */
  statement: z.string().min(1),
  /** Diagrams the statement references as `diagram:<index>`, pre-rendered to SVG. */
  diagrams: z.array(z.string().min(1)),
  /** Facts for the exercise header, verified automatically and not rated. */
  facts: z.strictObject({
    /** The template and solution compile, the solution passes every test, the template none. */
    gates_passed: z.boolean(),
    tests: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    /** What a student implements: methods and types the solution changes, and its added lines. */
    methods: z.number().int().nonnegative(),
    types: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
  }),
  template: z.array(fileSchema),
  diff: z.array(diffFileSchema),
  tests: z.array(
    z.strictObject({ task: z.string().min(1).nullable(), tests: z.array(testSchema).min(1) }),
  ),
  findings: z.strictObject({
    items: z.array(findingSchema),
    metrics: z.array(z.strictObject({ label: z.string().min(1), value: z.string().min(1) })),
  }),
});

export type Exercise = z.infer<typeof exerciseSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type DiffFile = z.infer<typeof diffFileSchema>;
export type Finding = z.infer<typeof findingSchema>;

/** The exercise as one step may see it: the header facts, plus only the material that is open. */
export interface ExerciseView {
  id: string;
  phase: Phase;
  facts: Exercise["facts"];
  brief?: string;
  statement?: string;
  diagrams?: number;
  template?: Exercise["template"];
  diff?: Exercise["diff"];
  tests?: Exercise["tests"];
  findings?: Exercise["findings"];
}

/** Cut an exercise down to the material a step has opened, so later material never leaves the server. */
export function viewOf(exercise: Exercise, open: readonly Material[]): ExerciseView {
  const view: ExerciseView = { id: exercise.id, phase: exercise.phase, facts: exercise.facts };
  for (const material of open) {
    if (material === "statement") {
      view.statement = exercise.statement;
      view.diagrams = exercise.diagrams.length;
    } else {
      Object.assign(view, { [material]: exercise[material] });
    }
  }
  return view;
}
