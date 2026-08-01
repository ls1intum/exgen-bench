import { join } from "node:path";
import { z } from "zod";

/**
 * The adapter's own on-disk resume record. It is a trust boundary: it is read back after a crash,
 * so a partial write, a file from an older adapter revision, or a hand edit all reach this parse.
 * The type is derived from the schema so the two cannot drift.
 */
export const adapterStateSchema = z.strictObject({
  schema_version: z.literal("3"),
  attempt_id: z.string().min(1),
  course_id: z.number().int().positive(),
  short_name: z.string().min(1),
  phase: z.enum(["create_intent", "exercise_created", "generation_started", "terminal"]),
  exercise_id: z.number().int().positive().optional(),
  job_id: z.string().min(1).optional(),
  deadline_at: z.iso.datetime({ offset: true }),
  telemetry_cursor_bytes: z.number().int().nonnegative().optional(),
  terminal_version_id: z.number().int().positive().optional(),
});

export type AdapterState = z.infer<typeof adapterStateSchema>;

/**
 * The fields cleanup needs to decide that a state record identifies an exercise this campaign owns.
 * Deliberately permissive about every other field: a complete record carries `phase`, `job_id` and
 * `deadline_at` too, and picking from the strict schema above would inherit its strictness and
 * reject every real state file — leaving the exercises this view exists to delete undeleted. Field
 * types are still taken from that schema, so a rename is a type error rather than a silent no-match.
 */
export const ownedExerciseSchema = z.looseObject({
  schema_version: adapterStateSchema.shape.schema_version,
  attempt_id: adapterStateSchema.shape.attempt_id,
  course_id: adapterStateSchema.shape.course_id,
  short_name: adapterStateSchema.shape.short_name,
  exercise_id: adapterStateSchema.shape.exercise_id.unwrap(),
});

export const statePath = (output: string): string => join(output, "artemis", "adapter-state.json");

/** Renders Zod issues as `field: problem`, matching the mismatch reports elsewhere in the adapter. */
function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}

export function parseAdapterState(raw: string): AdapterState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Artemis adapter state is not valid JSON, so the attempt cannot be resumed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = adapterStateSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Artemis adapter state is malformed (${describe(parsed.error)})`);
  }
  return parsed.data;
}
