#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { artemisParametersSchema, resolveCredentials, type ArtemisParameters } from "./config.ts";
import { cliPath, cliPositiveInteger } from "./entrypoint.ts";
import { ArtemisHttpClient, jwtCookie } from "./http.ts";
import { telemetryCursor, waitForTelemetryExport } from "./opentelemetry.ts";
import { effortProfilesSchema, exerciseSchema } from "./protocol.ts";
import { ownedExerciseSchema } from "./state.ts";
import { artemisTargetParametersSchema } from "./target.ts";

async function load(path: string, requireTelemetry: boolean): Promise<ArtemisParameters> {
  const parameters = artemisParametersSchema.parse(
    JSON.parse(await readFile(resolve(path), "utf8")),
  );
  if (requireTelemetry && !parameters.telemetry) {
    throw new Error("formal Artemis campaigns require OpenTelemetry capture");
  }
  return parameters;
}

async function client(parameters: ArtemisParameters): Promise<ArtemisHttpClient> {
  const credentials = resolveCredentials(parameters);
  const http = new ArtemisHttpClient(
    parameters.base_url,
    credentials.type === "bearer" ? `Bearer ${credentials.token}` : undefined,
    parameters.request_timeout_ms,
    parameters.max_http_retries,
    parameters.max_http_response_bytes,
    parameters.max_http_total_bytes,
    parameters.max_retry_delay_ms,
  );
  if (credentials.type === "password") {
    const authentication = await http.jsonResponse<unknown>("/api/core/public/authenticate", {
      method: "POST",
      body: { username: credentials.username, password: credentials.password, rememberMe: false },
    });
    const cookie = jwtCookie(authentication.headers);
    if (!cookie) throw new Error("Artemis authentication did not return its jwt cookie");
    http.setCookie(`jwt=${cookie}`);
  }
  return http;
}

async function listExercises(http: ArtemisHttpClient, courseId: number) {
  const listed = await http.json<unknown>(
    `/api/programming/courses/${courseId}/programming-exercises`,
  );
  if (!Array.isArray(listed)) throw new Error("configured Artemis course is not accessible");
  return listed.map((item) => exerciseSchema.parse(item));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function benchmarkEnvironment(
  telemetry: NonNullable<ArtemisParameters["telemetry"]>,
): Record<string, string> {
  return {
    // The Langfuse exporter filters spans required by the benchmark.
    MANAGEMENT_LANGFUSE_ENABLED: "false",
    MANAGEMENT_OPENTELEMETRY_ENABLED: "true",
    MANAGEMENT_TRACING_SAMPLING_PROBABILITY: "1.0",
    MANAGEMENT_TRACING_EXPORT_OTLP_ENABLED: "true",
    MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_ENDPOINT: telemetry.artemis_otlp_endpoint,
    MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_TRANSPORT: "http",
    // Keep export cadence below the harness quiescence window.
    MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_SCHEDULE_DELAY: "1s",
    MANAGEMENT_OPENTELEMETRY_INSTRUMENTATION_GEN_AI_CAPTURE_CONTENT: String(
      telemetry.content_capture === "required",
    ),
    MANAGEMENT_LOGGING_EXPORT_OTLP_ENABLED: "false",
    MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED: "false",
    SPRING_AI_OPENAI_MAX_RETRIES: "0",
  };
}

function buildProgram(): Command {
  const program = new Command()
    .name("artemis-campaign")
    .description("Artemis campaign operations for the exgen benchmark adapter");

  program
    .command("environment")
    .description("emit the secret-free Artemis environment map required for benchmark capture")
    .requiredOption("--parameters <path>", "adapter parameters JSON", cliPath)
    .action(async (options) => {
      const parameters = await load(options.parameters, true);
      if (!parameters.telemetry) throw new Error("environment rendering requires telemetry");
      process.stdout.write(
        `${JSON.stringify(benchmarkEnvironment(parameters.telemetry), null, 2)}\n`,
      );
    });

  program
    .command("preflight")
    .description(
      "verify course access, Hyperion support for the configured format, and live collector output",
    )
    .requiredOption("--parameters <path>", "adapter parameters JSON", cliPath)
    .option("--target-parameters <path>", "benchmark target.parameters JSON", cliPath)
    .option(
      "--allow-missing-telemetry",
      "run every check except telemetry delivery, for an exploratory development campaign that makes no usage-verification claim",
    )
    .action(async (options) => {
      // Telemetry is what turns reported usage into verified usage. An exploratory campaign may
      // legitimately not have a collector; it then has to say so rather than be unable to preflight
      // the course, format and effort-profile checks that are independent of it.
      const parameters = await load(options.parameters, options.allowMissingTelemetry !== true);
      const format = artemisTargetParametersSchema.parse(
        options.targetParameters
          ? JSON.parse(await readFile(resolve(options.targetParameters), "utf8"))
          : {},
      );
      const cursor = await telemetryCursor(parameters);
      const http = await client(parameters);
      const exercises = await listExercises(http, parameters.course_id);
      const languages = await http.json<unknown>(
        "/api/hyperion/programming-exercises/generation/supported-languages",
      );
      if (!Array.isArray(languages) || !languages.includes(format.language))
        throw new Error(
          `configured Artemis instance does not support Hyperion ${format.language} generation`,
        );
      const profiles = effortProfilesSchema.parse(
        (await http.json<unknown>(
          "/api/hyperion/programming-exercises/generation/effort-profiles",
        )) ?? [],
      );
      const requestedProfile = parameters.generation?.effort_profile;
      if (requestedProfile !== undefined && !profiles.some((p) => p.name === requestedProfile)) {
        throw new Error(
          `configured Artemis instance offers no generation effort profile named ${JSON.stringify(requestedProfile)}`,
        );
      }
      const telemetry = await waitForTelemetryExport(parameters, cursor);
      printJson({
        course_id: parameters.course_id,
        existing_exercises: exercises.length,
        effort_profiles: profiles.map((profile) => profile.name),
        // Preflight attests language; Artemis validates project type when generation starts.
        generation_language: format.language,
        project_type: format.project_type,
        ...(telemetry === undefined
          ? { opentelemetry: "absent: no usage or provider-request-id verification was performed" }
          : { opentelemetry: telemetry }),
      });
    });

  program
    .command("cleanup")
    .description("delete only the exercises recorded in adapter state beneath a run directory")
    .requiredOption("--parameters <path>", "adapter parameters JSON", cliPath)
    .requiredOption("--run-dir <path>", "campaign run directory holding adapter state", cliPath)
    .requiredOption(
      "--confirm-course-id <id>",
      "must exactly match parameters.course_id",
      cliPositiveInteger,
    )
    .option("--dry-run", "report what would be deleted without deleting anything")
    .action(async (options) => {
      const parameters = await load(options.parameters, false);
      const confirmed = options.confirmCourseId;
      if (confirmed !== parameters.course_id)
        throw new Error("--confirm-course-id must exactly match parameters.course_id");
      const runDirectory = resolve(options.runDir);
      const owned = new Map<number, string>();
      const unreadable: string[] = [];
      for await (const relative of new Bun.Glob("**/artemis/adapter-state.json").scan({
        cwd: runDirectory,
        onlyFiles: true,
      })) {
        let record: unknown;
        try {
          record = JSON.parse(await readFile(resolve(runDirectory, relative), "utf8"));
        } catch {
          unreadable.push(relative);
          continue;
        }
        const state = ownedExerciseSchema.safeParse(record);
        if (!state.success) {
          unreadable.push(relative);
          continue;
        }
        if (state.data.course_id === confirmed) {
          owned.set(state.data.exercise_id, state.data.short_name);
        }
      }
      const http = await client(parameters);
      const exercises = await listExercises(http, parameters.course_id);
      const results: Array<{
        exercise_id: number;
        short_name: string;
        outcome: "deleted" | "skipped" | "failed";
        error?: string;
      }> = [];
      for (const exercise of exercises) {
        const expectedShortName = owned.get(exercise.id);
        if (!expectedShortName || exercise.shortName !== expectedShortName) continue;
        if (!exercise.shortName.startsWith(parameters.exercise.short_name_prefix)) continue;
        if (options.dryRun) {
          results.push({
            exercise_id: exercise.id,
            short_name: exercise.shortName,
            outcome: "skipped",
          });
          continue;
        }
        try {
          await http.json(
            `/api/programming/programming-exercises/${exercise.id}?deleteStudentReposBuildPlans=true&deleteBaseReposBuildPlans=true`,
            { method: "DELETE" },
          );
          results.push({
            exercise_id: exercise.id,
            short_name: exercise.shortName,
            outcome: "deleted",
          });
        } catch (error) {
          results.push({
            exercise_id: exercise.id,
            short_name: exercise.shortName,
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const failed = results.filter((result) => result.outcome === "failed").length;
      printJson({
        course_id: confirmed,
        ledger_owned: owned.size,
        ...(unreadable.length > 0 ? { unreadable_state_files: unreadable } : {}),
        dry_run: Boolean(options.dryRun),
        deleted: results.filter((result) => result.outcome === "deleted").length,
        failed,
        results,
      });
      if (failed > 0) process.exitCode = 1;
    });

  return program;
}

export async function runCampaign(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  if (argv.length <= 2) {
    process.stdout.write(program.helpInformation());
    return;
  }
  await program.parseAsync(argv);
}

if (import.meta.main) await runCampaign();
