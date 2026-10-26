#!/usr/bin/env bun

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { sha256 } from "../../../src/core/canonical.ts";
import { exportArchive } from "../server/export.ts";
import { SurveyStore } from "../server/store.ts";
import { type LoadedStudy, loadInstrument, type Study, studySchema } from "../server/study.ts";
import { stepKey } from "../shared/flow.ts";
import {
  type Answer,
  answerIssues,
  type Instrument,
  type Item,
  normalizeAnswers,
  type SectionAnswers,
} from "../shared/instrument.ts";
import { readinessClass } from "../shared/readiness.ts";

/**
 * A simulated run of the study design's plan, for testing the analysis before any rater answers:
 * eight main raters rate twelve exercises, one of them stops after the first exercise and a reserve
 * rater takes over the rest, and the other reserve rater breaks ties. Answers are seeded and follow
 * a simple model, in which an exercise has a quality and a rater a severity, so the statistics have
 * something to find. Nothing here is evidence about real exercises.
 */

/** The plan of the study design (Section 4). */
const PLAN: Record<string, string[]> = {
  R1: ["E1", "M1", "L1"],
  R2: ["M2", "E1", "L2"],
  R3: ["M1", "L3", "E2"],
  R4: ["E2", "L4", "M2"],
  R5: ["L1", "E3", "M3"],
  R6: ["L2", "M4", "E3"],
  R7: ["E4", "M3", "L3"],
  R8: ["L4", "E4", "M4"],
};
const DROPOUT = "R8";
const BACKUP = "R10";
const TIE_BREAKER = "R9";

/** Mulberry32: a small seeded generator, so the same seed gives the same answers. */
function generator(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  const pick = <T>(values: readonly T[]): T => values[Math.floor(uniform() * values.length)] as T;
  return { uniform, normal, pick };
}

function simulatedStudy(): Study {
  const codes = ["E", "M", "L"].flatMap((phase) => [1, 2, 3, 4].map((index) => `${phase}${index}`));
  return studySchema.parse({
    schema_version: "1",
    id: "expert-rating-simulation",
    title: "Expert study, simulated answers",
    instrument_version: "1",
    contact: { name: "Study team", email: "study-team@example.org" },
    deadlines: {},
    consent: {
      summary: "Simulated raters.",
      details: "Simulated raters.",
      statements: [{ id: "participate", text: "Simulated consent." }],
    },
    ratings_per_exercise: 2,
    exercises: codes.map((code) => ({
      code,
      phase: { E: "early", M: "middle", L: "late" }[code[0] as "E" | "M" | "L"],
      source: { run: "simulated", case: code },
    })),
    calibration: {
      code: "CAL",
      phase: "early",
      source: { run: "simulated", case: "CAL" },
      reference: {
        CL1: { answer: { value: "yes" }, explanation: "Simulated." },
        SO1: { answer: { value: "yes" }, explanation: "Simulated." },
        FB1: { answer: { value: "yes" }, explanation: "Simulated." },
        RD1: { answer: { value: 4 }, explanation: "Simulated." },
      },
    },
    raters: [
      ...Object.entries(PLAN).map(([id, exercises]) => ({ id, role: "main", exercises })),
      { id: TIE_BREAKER, role: "reserve" },
      { id: BACKUP, role: "reserve" },
    ],
  });
}

export async function simulateExport(seed: number): Promise<Uint8Array> {
  const random = generator(seed);
  const study = simulatedStudy();
  const instrument: Instrument = await loadInstrument();
  const codes = [...study.exercises.map((entry) => entry.code), study.calibration.code];
  const loaded: LoadedStudy = {
    directory: "simulated",
    study,
    instrument,
    manifest: {
      schema_version: "1",
      study_id: study.id,
      exercises: codes.map((code, index) => ({
        code,
        id: `S${String(index).padStart(3, "0")}`,
        phase: code === "CAL" ? "early" : (study.exercises[index]?.phase ?? "early"),
        sha256: sha256(`simulated ${code}`),
        source: {
          run_id: "simulated",
          attempt_id: code,
          case_id: code,
          system_id: "simulated",
          artifact_digest: sha256(`simulated artifact ${code}`),
        },
        blinding_replacements: 0,
      })),
    },
    exercises: new Map(),
    idOf: new Map(codes.map((code, index) => [code, `S${String(index).padStart(3, "0")}`])),
  };

  // The model: an exercise has a quality, a rater a severity; both shift every judgement.
  const quality = new Map(codes.map((code) => [code, random.normal()]));
  const severity = new Map(study.raters.map((rater) => [rater.id, 0.5 * random.normal()]));
  const readiness = (code: string, rater: string) =>
    Math.min(
      5,
      Math.max(
        1,
        Math.round(
          3.3 + 0.9 * (quality.get(code) ?? 0) - (severity.get(rater) ?? 0) + 0.5 * random.normal(),
        ),
      ),
    );

  const answer = (item: Item, value: Answer["value"] | string[]): Answer => {
    if (item.kind === "text") {
      return { text: "Simulated answer." };
    }
    const values = Array.isArray(value) ? value : [value];
    const chosen = item.options.filter((option) => values.includes(option.value));
    const detail = chosen.find((option) => option.detail !== undefined)?.detail;
    return {
      ...(item.kind === "multi" ? { values: values as string[] } : { value: value as string }),
      ...(detail === undefined ? {} : { text: "Simulated reason." }),
      ...(detail?.choices === undefined ? {} : { choice: random.pick(detail.choices).value }),
    };
  };

  /** Answers for one section: the model's values where it has one, else a random option. */
  const section = (items: Item[], model: (item: Item) => Answer["value"] | undefined) => {
    const answers: SectionAnswers = {};
    for (const item of items) {
      if (item.kind === "text") {
        answers[item.id] = answer(item, undefined);
      } else if (item.kind === "multi") {
        const option = random.pick(item.options);
        answers[item.id] = answer(item, [String(option.value)]);
      } else {
        answers[item.id] = answer(item, model(item) ?? random.pick(item.options).value);
      }
    }
    const issues = answerIssues(items, answers);
    if (issues.length > 0) {
      throw new Error(`simulated answers are invalid: ${JSON.stringify(issues)}`);
    }
    return normalizeAnswers(items, answers);
  };

  // Simulated time: each part takes about as long as the study design budgets for it.
  let time = Date.parse("2026-11-02T09:00:00Z");
  const advance = (minutes: number) => {
    time += Math.round(minutes * 60_000);
  };
  const BUDGET = { A: 5, B: 7, C: 3, D: 3 } as const;

  const directory = await mkdtemp(join(tmpdir(), "exgen-survey-simulation-"));
  const store = SurveyStore.open(join(directory, "survey.sqlite"), loaded, {
    create: true,
    clock: () => new Date(time),
  });
  try {
    const rd1 = new Map<string, number>();
    const rd2 = new Map<string, number>();
    /** Answer every step a rater can reach, stopping after `stopAfter` exercises when given. */
    const rate = (raterId: string, stopAfter?: number) => {
      for (;;) {
        const rater = store.rater(raterId);
        if (rater === null) throw new Error(`no rater ${raterId}`);
        const step = store.current(rater);
        const key = stepKey(step);
        const submit = (answers: unknown) => {
          advance(step.kind === "part" ? BUDGET[step.part] * Math.exp(0.35 * random.normal()) : 2);
          store.submit(rater, step, answers, instrument.version);
        };
        if (step.kind === "consent") {
          submit({ accepted: study.consent.statements.map((statement) => statement.id) });
        } else if (step.kind === "background" || step.kind === "exit") {
          submit(section(instrument[step.kind].items, () => undefined));
        } else if (step.kind === "onboarding" || step.kind === "calibration_review") {
          submit({});
        } else if (step.kind === "calibration") {
          store.open(raterId, key);
          submit(section(instrument.calibration.items, () => undefined));
        } else if (step.kind === "part") {
          const position = store
            .assignments(raterId)
            .findIndex((row) => row.position === step.position);
          if (stopAfter !== undefined && position >= stopAfter) return;
          const code = store.assignments(raterId)[position]?.exercise ?? "";
          const items =
            instrument.questionnaire.parts.find((part) => part.id === step.part)?.items ?? [];
          const yes = (bias: number) =>
            1 /
              (1 +
                Math.exp(-(1.4 + bias + (quality.get(code) ?? 0) - (severity.get(raterId) ?? 0)))) >
            random.uniform()
              ? "yes"
              : "no";
          store.open(raterId, key);
          submit(
            section(items, (item) => {
              if (item.kind !== "choice") return undefined;
              const values = item.options.map((option) => option.value);
              if (item.id === "RD1") {
                const value = readiness(code, raterId);
                rd1.set(`${raterId}/${code}`, value);
                return value;
              }
              if (item.id === "RD2") {
                const before = rd1.get(`${raterId}/${code}`) ?? 3;
                const shift = random.uniform() < 0.2 ? -1 : random.uniform() < 0.05 ? 1 : 0;
                const value = Math.min(5, Math.max(1, before + shift));
                rd2.set(`${raterId}/${code}`, value);
                return value;
              }
              if (item.id === "AF1") return random.uniform() < 0.2 ? "yes" : "no";
              if (item.id === "AF2") return random.uniform() < 0.65 ? "yes" : "no";
              if (values.includes("na") && random.uniform() < 0.08) return "na";
              return values.includes("yes") ? yes(item.id.startsWith("O") ? 0.5 : 0) : undefined;
            }),
          );
        } else {
          return;
        }
      }
    };

    for (const raterId of Object.keys(PLAN)) {
      rate(raterId, raterId === DROPOUT ? 1 : undefined);
    }
    // The backup takes over the exercises the dropout did not rate.
    rate(BACKUP);
    store.assign(BACKUP, PLAN[DROPOUT]?.slice(1) ?? [], "backup", DROPOUT);
    rate(BACKUP);

    // The tie breaker rates up to three exercises whose planned RD2 classes differ.
    const differing = study.exercises
      .map((entry) => entry.code)
      .filter((code) => {
        const classes = new Set(
          [...rd2.entries()]
            .filter(([key]) => key.endsWith(`/${code}`))
            .map(([, value]) => readinessClass(value)),
        );
        return classes.size > 1;
      })
      .slice(0, 3);
    rate(TIE_BREAKER);
    if (differing.length > 0) {
      store.assign(TIE_BREAKER, differing, "tie_breaker", null);
    }
    rate(TIE_BREAKER);
    return exportArchive(loaded, store, ["main", "reserve"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      seed: { type: "string", default: "20261026" },
    },
  });
  if (values.output === undefined) {
    throw new Error("usage: simulate.ts --output <export.zip> [--seed <integer>]");
  }
  await writeFile(resolve(values.output), await simulateExport(Number(values.seed)));
  process.stdout.write(`${resolve(values.output)}\n`);
}
