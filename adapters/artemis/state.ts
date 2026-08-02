import { join } from "node:path";
import { z } from "zod";

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

/** Cleanup view: require ownership fields while accepting the rest of a complete state record. */
export const ownedExerciseSchema = z.looseObject({
  schema_version: adapterStateSchema.shape.schema_version,
  attempt_id: adapterStateSchema.shape.attempt_id,
  course_id: adapterStateSchema.shape.course_id,
  short_name: adapterStateSchema.shape.short_name,
  exercise_id: adapterStateSchema.shape.exercise_id.unwrap(),
});

export const statePath = (output: string): string => join(output, "artemis", "adapter-state.json");

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
