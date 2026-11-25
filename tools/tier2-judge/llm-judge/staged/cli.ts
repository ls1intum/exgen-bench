#!/usr/bin/env bun

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parse } from "yaml";

import { canonicalJson, sha256 } from "../../../../src/core/canonical.ts";
import { loadInstrumentVersion } from "../../../tier3-expert-rating/builder/study.ts";
import { type Exercise, exerciseSchema } from "../../../tier3-expert-rating/shared/exercise.ts";
import type { Instrument } from "../../../tier3-expert-rating/shared/instrument.ts";
import { callPlan, STAGED_JUDGE_VERSION } from "./contract.ts";
import { stageMaterial } from "./material.ts";
import { rubricSha256, systemMessage, userMessage } from "./prompt.ts";
import { type ExerciseJudgement, judgeExercise } from "./run.ts";
import {
  type JudgeConfig,
  judgeConfigSchema,
  OpenAiCompatibleTransport,
  type Transport,
} from "./transport.ts";

const USAGE = `Staged Expert Study judge (see tools/tier2-judge/llm-judge/STAGED-JUDGE.md)

  bun run tools/tier2-judge/llm-judge/staged/cli.ts judge \\
      --config judge.yaml --output DIR (--exercise FILE ... | --exercises DIR) \\
      [--instrument-version 7] [--model ID] [--base-url URL]

  bun run tools/tier2-judge/llm-judge/staged/cli.ts preview \\
      --output DIR (--exercise FILE ... | --exercises DIR) [--instrument-version 7]

judge    asks the configured OpenAI-compatible model, five calls per exercise. The credential is
         read from the environment variable the configuration names in provider.api_key_env.
preview  writes the A, B, C and D-RD2 prompts without contacting any model.

Exercises are the study's blinded exercise documents (exercises/<ID>.json); manifest.json, which
holds provenance, is never read. Exit status: 0 when every call was answered, 2 when the run
finished with a model error, invalid output or unavailable call, 1 on a usage or input error.`;

export async function loadExercises(
  files: string[],
  directories: string[],
  archiveDigests = new Map<string, string>(),
): Promise<Exercise[]> {
  const paths = files.map((file) => resolve(file));
  for (const directory of directories) {
    for (const name of (await readdir(directory)).sort()) {
      if (name.endsWith(".json") && name !== "manifest.json") paths.push(resolve(directory, name));
    }
  }
  if (paths.length === 0) throw new Error("no exercise given");
  const exercises: Exercise[] = [];
  for (const path of paths) {
    if (basename(path) === "manifest.json") {
      throw new Error("manifest.json holds provenance and is not an exercise");
    }
    const bytes = await readFile(path);
    const parsed = exerciseSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success)
      throw new Error(`${path} is not a study exercise: ${parsed.error.message}`);
    if (exercises.some((exercise) => exercise.id === parsed.data.id)) {
      throw new Error(`exercise ${parsed.data.id} is given twice`);
    }
    exercises.push(parsed.data);
    archiveDigests.set(parsed.data.id, sha256(bytes));
  }
  return exercises;
}

/** The instrument a study names, refusing the silent fallback to the current instrument. */
export async function loadJudgeInstrument(version: string): Promise<Instrument> {
  const instrument = await loadInstrumentVersion(version);
  if (instrument.version !== version) {
    throw new Error(
      `instrument ${version} does not exist (the current one is ${instrument.version})`,
    );
  }
  callPlan(instrument);
  return instrument;
}

async function emptyOutput(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) {
    throw new Error(`${directory} is not empty; the judge does not overwrite earlier records`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function loadConfig(
  path: string,
  overrides: { model?: string; baseUrl?: string },
): Promise<JudgeConfig> {
  const raw = parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const config = judgeConfigSchema.parse(raw);
  return {
    ...config,
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    provider: {
      ...config.provider,
      ...(overrides.baseUrl === undefined ? {} : { base_url: overrides.baseUrl }),
    },
  };
}

/** Judge every exercise and write one record per exercise, the item rows, and the run summary. */
export async function runJudge(options: {
  exercises: Exercise[];
  archiveDigests?: ReadonlyMap<string, string>;
  instrument: Instrument;
  transport: Transport;
  config: Pick<JudgeConfig, "max_attempts" | "setup_reads">;
  output: string;
  retryDelayMs?: number;
}): Promise<ExerciseJudgement[]> {
  await emptyOutput(options.output);
  const judgements: ExerciseJudgement[] = [];
  for (const exercise of options.exercises) {
    const judgement = await judgeExercise(exercise, options.instrument, options.transport, {
      maxAttempts: options.config.max_attempts,
      setupReads: {
        enabled: options.config.setup_reads.enabled,
        maxFiles: options.config.setup_reads.max_files,
      },
      retryDelayMs: options.retryDelayMs ?? 1000,
    });
    judgements.push(judgement);
    await writeJson(join(options.output, `${exercise.id}.judgement.json`), judgement);
  }
  const rows = judgements.flatMap((judgement) => judgement.rows);
  await writeFile(
    join(options.output, "rows.jsonl"),
    rows.map((row) => canonicalJson(row)).join("\n") + "\n",
    "utf8",
  );
  const statuses: Record<string, number> = {};
  for (const call of judgements.flatMap((judgement) => judgement.calls)) {
    statuses[call.status] = (statuses[call.status] ?? 0) + 1;
  }
  await writeJson(join(options.output, "run.json"), {
    judge_version: STAGED_JUDGE_VERSION,
    rubric_version: options.instrument.version,
    rubric_sha256: rubricSha256(options.instrument),
    transport: options.transport.describe(),
    max_attempts: options.config.max_attempts,
    setup_reads: options.config.setup_reads,
    exercises: judgements.map((judgement) => ({
      id: judgement.exercise_id,
      sha256: judgement.exercise_sha256,
      archive_sha256: options.archiveDigests?.get(judgement.exercise_id) ?? null,
      calls: Object.fromEntries(judgement.calls.map((call) => [call.call, call.status])),
    })),
    call_statuses: statuses,
  });
  return judgements;
}

/** The prompts of the calls that need no earlier answer, for review without any model. */
export async function writePreview(
  exercises: Exercise[],
  instrument: Instrument,
  output: string,
): Promise<void> {
  await emptyOutput(output);
  for (const exercise of exercises) {
    const directory = join(output, exercise.id);
    await mkdir(directory);
    for (const plan of callPlan(instrument).filter((candidate) => candidate.prior.length === 0)) {
      const part = instrument.questionnaire.parts.find((candidate) => candidate.id === plan.part);
      if (part === undefined) continue;
      const material = stageMaterial(exercise, instrument, plan.part);
      const user = userMessage({
        instrument,
        part,
        phase: exercise.phase,
        plan,
        material,
        prior: [],
        setupReads: { enabled: true, maxFiles: 4 },
      });
      await writeFile(join(directory, `${plan.id}.md`), user, "utf8");
    }
    await writeFile(join(directory, "system.md"), systemMessage(instrument), "utf8");
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      output: { type: "string" },
      exercise: { type: "string", multiple: true, default: [] },
      exercises: { type: "string", multiple: true, default: [] },
      "instrument-version": { type: "string", default: "7" },
      model: { type: "string" },
      "base-url": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || (command !== "judge" && command !== "preview")) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 1;
  }
  if (values.output === undefined) throw new Error("--output is required");
  const instrument = await loadJudgeInstrument(values["instrument-version"]);
  const archiveDigests = new Map<string, string>();
  const exercises = await loadExercises(values.exercise, values.exercises, archiveDigests);
  if (command === "preview") {
    await writePreview(exercises, instrument, resolve(values.output));
    process.stdout.write(`Wrote prompts for ${exercises.length} exercise(s) to ${values.output}\n`);
    return 0;
  }
  if (values.config === undefined) throw new Error("--config is required");
  const config = await loadConfig(values.config, {
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values["base-url"] === undefined ? {} : { baseUrl: values["base-url"] }),
  });
  const apiKey = process.env[config.provider.api_key_env];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `set the credential in the environment variable ${config.provider.api_key_env}`,
    );
  }
  const judgements = await runJudge({
    exercises,
    archiveDigests,
    instrument,
    transport: new OpenAiCompatibleTransport(config, apiKey),
    config,
    output: resolve(values.output),
  });
  const calls = judgements.flatMap((judgement) => judgement.calls);
  const unanswered = calls.filter((call) => call.status !== "answered");
  process.stdout.write(
    `Judged ${judgements.length} exercise(s): ${calls.length - unanswered.length} of ${calls.length} calls answered.\n`,
  );
  for (const call of unanswered) {
    const judgement = judgements.find((candidate) => candidate.calls.includes(call));
    process.stdout.write(
      `  ${judgement?.exercise_id} ${call.call}: ${call.status} (${call.issues.join("; ")})\n`,
    );
  }
  return unanswered.length === 0 ? 0 : 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
