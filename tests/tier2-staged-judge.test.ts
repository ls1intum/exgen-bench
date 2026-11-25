import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sha256 } from "../src/core/canonical.ts";
import {
  loadExercises,
  loadJudgeInstrument,
  runJudge,
  stagedJudgeCli,
} from "../tools/tier2-judge/llm-judge/staged/cli.ts";
import {
  callPlan,
  InstrumentContractError,
} from "../tools/tier2-judge/llm-judge/staged/contract.ts";
import { locatorProblem, stageMaterial } from "../tools/tier2-judge/llm-judge/staged/material.ts";
import type { ChatMessage } from "../tools/tier2-judge/llm-judge/staged/prompt.ts";
import {
  type ExerciseJudgement,
  judgeExercise,
} from "../tools/tier2-judge/llm-judge/staged/run.ts";
import {
  type Completion,
  judgeConfigSchema,
  OpenAiCompatibleTransport,
  ScriptedTransport,
  TransportError,
} from "../tools/tier2-judge/llm-judge/staged/transport.ts";
import { exerciseSchema } from "../tools/tier3-expert-rating/shared/exercise.ts";
import {
  answerIssues,
  type Instrument,
  type Item,
} from "../tools/tier3-expert-rating/shared/instrument.ts";

const instrument = await loadJudgeInstrument("7");
const synthetic = exerciseSchema.parse(
  JSON.parse(await readFile("tests/fixtures/staged-judge/synthetic-exercise.json", "utf8")),
);
const REAL_EXERCISES = "tools/tier3-expert-rating/server/src/test/resources/study/exercises";
const items = instrument.questionnaire.parts.flatMap((part) => part.items);
const itemOf = (id: string): Item => {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
};

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "staged-judge-"));
  temporary.push(directory);
  return directory;
}

/** The item IDs a call asks for, read from its "How to answer" line. */
function askedItems(messages: ChatMessage[]): string[] {
  const user = messages[1]?.content ?? "";
  const line = /^Answer (.+) in one JSON object:$/m.exec(user)?.[1] ?? "";
  return [...line.matchAll(/"([A-Z0-9]+)"/g)].map((match) => match[1] ?? "");
}

function partOf(messages: ChatMessage[]): string {
  return /^# Part ([A-D]) ·/m.exec(messages[1]?.content ?? "")?.[1] ?? "?";
}

/** A valid answer for every asked item: the first option with a detail, cited at material level. */
function validAnswers(ids: string[], part: string) {
  const materials: Record<string, string> = {
    A: "statement",
    B: "brief",
    C: "tests",
    D: "findings",
  };
  const answers: Record<string, unknown> = {};
  for (const id of ids) {
    const item = itemOf(id);
    if (item.kind !== "choice") continue;
    const option = item.options.find((candidate) => candidate.detail !== undefined);
    if (option === undefined) throw new Error(`${id} has no option with a detail`);
    answers[id] = {
      value: option.value,
      ...(option.detail?.choices === undefined ? {} : { choice: option.detail.choices[0]?.value }),
      text: `main change for ${id}`,
      evidence_refs: [`material:${materials[part]}`],
      rationale: "Synthetic.",
    };
  }
  return { answers };
}

function reply(content: string, extra: Partial<Completion> = {}): Completion {
  return {
    content,
    finishReason: "stop",
    model: "fake-model-2026",
    providerRequestId: "req",
    ...extra,
  };
}

const validTransport = () =>
  new ScriptedTransport((messages) =>
    reply(JSON.stringify(validAnswers(askedItems(messages), partOf(messages)))),
  );

const options = { maxAttempts: 2, setupReads: { enabled: true, maxFiles: 4 }, retryDelayMs: 0 };

function allPrompts(judgement: ExerciseJudgement, call: string): string {
  const record = judgement.calls.find((candidate) => candidate.call === call);
  return (record?.messages ?? []).map((message) => message.content).join("\n");
}

describe("call plan against the canonical instrument", () => {
  test("instrument 7 gives four fresh calls for the six exercise judgements", () => {
    const plans = callPlan(instrument);
    expect(plans.map((plan) => [plan.id, plan.items.map((item) => item.id)])).toEqual([
      ["A", ["SPEC"]],
      ["B", ["GOAL", "SUPPORT"]],
      ["C", ["FEEDBACK", "RD1"]],
      ["D-RD2", ["RD2"]],
    ]);
  });

  test("refuse an instrument whose parts do not ask the expected items", () => {
    const changed: Instrument = structuredClone(instrument);
    const partC = changed.questionnaire.parts[2];
    if (partC === undefined) throw new Error("no part C");
    partC.items = partC.items.filter((item) => item.id !== "FEEDBACK");
    expect(() => callPlan(changed)).toThrow(InstrumentContractError);
  });

  test("refuse the loader's silent fallback for an instrument that does not exist", async () => {
    await expect(loadJudgeInstrument("99")).rejects.toThrow("instrument 99 does not exist");
  });
});

describe("stage material", () => {
  const sentinels = {
    brief: "SENTINEL_BRIEF_TEXT",
    diff: "SENTINEL_SOLUTION_CODE",
    tests: "SENTINEL_TEST_MESSAGE",
    findings: "SENTINEL_FINDING_DETAIL",
  };
  const text = (part: "A" | "B" | "C" | "D") =>
    stageMaterial(synthetic, instrument, part)
      .sections.map((section) => `${section.label}\n${section.caption ?? ""}\n${section.text}`)
      .join("\n");

  test("release each kind of material only from the part that opens it", () => {
    const visible = (part: "A" | "B" | "C" | "D") =>
      Object.entries(sentinels)
        .filter(([, sentinel]) => text(part).includes(sentinel))
        .map(([material]) => material);
    expect(visible("A")).toEqual([]);
    expect(visible("B")).toEqual(["brief", "diff"]);
    expect(visible("C")).toEqual(["brief", "diff", "tests"]);
    expect(visible("D")).toEqual(["brief", "diff", "tests", "findings"]);
  });

  test("leave out facts, the exercise ID, severities and generic flags", () => {
    for (const part of ["A", "B", "C", "D"] as const) {
      const shown = text(part);
      expect(shown).not.toMatch(/9876[1-5]/);
      expect(shown).not.toContain("ZQ7X");
      expect(shown).not.toMatch(/\bseverity\b|\bwarning\b|\bgeneric\b/i);
    }
  });

  test("group routine setup files and keep a file the task names or exercise data in the main tree", () => {
    const material = stageMaterial(synthetic, instrument, "A");
    expect(material.setup.map((file) => file.path)).toEqual([
      ".gitignore",
      ".vscode/tasks.json",
      "build.gradle",
      "gradle/wrapper/gradle-wrapper.properties",
      "gradlew",
    ]);
    const template = material.sections.find((section) => section.material === "template")?.text;
    expect(template).toContain("Build and setup files (5), closed by default:");
    expect(template).toContain("=== file: settings.gradle");
    expect(template).toContain("=== file: src/de/tum/cit/aet/log/data/build.gradle");
    // A closed setup file's content is available on request, not in the first view.
    expect(template).not.toContain("SENTINEL_SETUP_CONTENT");
  });

  test("open the setup group when every starter file is a setup file, with nothing left to request", () => {
    const onlySetup = {
      ...synthetic,
      template: synthetic.template.filter((file) => file.path === "build.gradle"),
    };
    const material = stageMaterial(onlySetup, instrument, "A");
    expect(material.setup).toEqual([]);
    const template = material.sections.find((section) => section.material === "template")?.text;
    expect(template).toContain("All starter files are build and setup files");
    expect(template).toContain("SENTINEL_SETUP_CONTENT");
  });

  test("mark files the solution changes only once the solution changes are open", () => {
    expect(text("A")).not.toContain("(M:");
    expect(text("B")).toContain(
      "src/de/tum/cit/aet/log/TemperatureLog.java (M: the sample solution changes this file)",
    );
  });

  test("show tests as the survey does: outcomes, variants, empty and shared messages", () => {
    const tests = text("C");
    expect(tests).toContain("- test: averageOfEmptyLog · passes on the starter code");
    expect(tests).toContain("- test: averageOfThreeReadings · fails on the starter code");
    expect(tests).toContain(
      "This test produced the message below after a deliberate change to the sample solution:",
    );
    expect(tests).toContain("Change made: average() divides by the count minus one");
    expect(tests).toContain("Not linked to a task · 2 tests");
    expect(tests).toContain("All 2 tests fail on the starter code with the same message:");
    expect(tests).toContain("[Task: Report · No tests]");
    expect(text("A")).not.toContain("[Task: Report · No tests]");
    expect(text("B")).toContain("[Task: Report]");
  });

  test("distinguish missing starter outcomes from recorded failures", () => {
    const exercise = {
      ...synthetic,
      tests: [
        {
          task: null,
          tests: [
            { name: "unrecordedA", message: "", generic: false },
            { name: "unrecordedB", message: "", generic: false },
          ],
        },
      ],
    };
    const tests = stageMaterial(exercise, instrument, "C").sections.find(
      (section) => section.material === "tests",
    )?.text;
    expect(tests).toContain("- test: unrecordedA · Starter-code result unavailable");
    expect(tests).toContain("- test: unrecordedB · Starter-code result unavailable");
    expect(tests).not.toContain("fail on the starter code");
  });

  test("show findings through the shared presentation, measurements explained", () => {
    const findings = text("D");
    expect(findings).toContain("\nTests\n");
    expect(findings).toContain("F1 · Tests still pass after selected edits to the solution");
    expect(findings).not.toContain("None reported");
    expect(findings).toContain("\nFuture family\n");
    expect(findings).toContain("Measurements and checks that couldn’t run");
    expect(findings).toContain("- Modified solutions rejected by tests: 3 of 4");
  });

  test("digest what a stage makes available, stable across builds and distinct between stages", () => {
    const digest = (part: "A" | "B" | "C" | "D") =>
      stageMaterial(synthetic, instrument, part).evidenceSha256;
    expect(digest("A")).toBe(digest("A"));
    expect(new Set([digest("A"), digest("B"), digest("C"), digest("D")]).size).toBe(4);
  });

  test("accept only locators for material the stage shows", () => {
    const a = stageMaterial(synthetic, instrument, "A").locators;
    const c = stageMaterial(synthetic, instrument, "C").locators;
    expect(locatorProblem("statement:L3-L4", a)).toBeNull();
    expect(locatorProblem("task:Average", a)).toBeNull();
    expect(locatorProblem("file:build.gradle", a)).toBeNull();
    expect(locatorProblem("file:src/de/tum/cit/aet/log/TemperatureLog.java:L9", a)).toBeNull();
    expect(locatorProblem("statement:L999", a)).toContain("outside");
    expect(locatorProblem("test:averageOfEmptyLog", a)).toContain("names nothing");
    expect(locatorProblem("brief:L1", a)).toContain("not available");
    expect(locatorProblem("test:averageOfEmptyLog", c)).toBeNull();
    expect(locatorProblem("finding:F1", c)).toContain("names nothing");
  });
});

describe("staged judge run", () => {
  test("answer the six exercise judgements in four fresh calls", async () => {
    const transport = validTransport();
    const judgement = await judgeExercise(synthetic, instrument, transport, options);
    expect(judgement.calls.map((call) => [call.call, call.status])).toEqual([
      ["A", "answered"],
      ["B", "answered"],
      ["C", "answered"],
      ["D-RD2", "answered"],
    ]);
    expect(transport.calls).toHaveLength(4);
    // Each call is a new conversation: a system and a user message, no earlier reply.
    for (const messages of transport.calls) {
      expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    }
    expect(allPrompts(judgement, "D-RD2")).not.toContain("Your earlier decisions");
    expect(allPrompts(judgement, "D-RD2")).not.toContain("What did the automatic checks add");
    expect(allPrompts(judgement, "D-RD2")).not.toContain("main change for RD1");

    expect(judgement.rows.map((row) => [row.item_id, row.status])).toEqual([
      ["SPEC", "answered"],
      ["GOAL", "answered"],
      ["SUPPORT", "answered"],
      ["FEEDBACK", "answered"],
      ["RD1", "answered"],
      ["RD2", "answered"],
    ]);
    // Every stored answer passes the survey's own answer rules.
    for (const row of judgement.rows.filter((candidate) => candidate.answer !== null)) {
      expect(answerIssues([itemOf(row.item_id)], { [row.item_id]: row.answer ?? {} })).toEqual([]);
      expect(row.models).toEqual(["fake-model-2026"]);
    }
    expect(judgement.rubric_version).toBe("7");
    expect(judgement.exercise_id).toBe("ZQ7X");
  });

  test("give raters' guidance verbatim: rule, example, notes, options and detail fields", async () => {
    const judgement = await judgeExercise(synthetic, instrument, validTransport(), options);
    const system = judgement.calls[0]?.messages[0]?.content ?? "";
    expect(system).toContain(instrument.materiality_rule.trim());
    const example = instrument.rating_example?.trim();
    if (!example) throw new Error("Missing readiness examples");
    expect(system).not.toContain(example);
    for (const call of judgement.calls) {
      const user = call.messages[1]?.content ?? "";
      if (call.items.includes("RD1") || call.items.includes("RD2")) {
        expect(user).toContain(example);
      } else {
        expect(user).not.toContain(example);
      }
      for (const item of call.items.map(itemOf)) {
        expect(user).toContain(item.prompt.trim());
        if (item.kind !== "choice") continue;
        if (item.note !== undefined) expect(user).toContain(item.note.trim());
        for (const option of item.options) {
          expect(user).toContain(`${JSON.stringify(option.value)} · ${option.label}`);
          if (option.description !== undefined) expect(user).toContain(option.description);
          if (option.detail !== undefined) expect(user).toContain(option.detail.label);
          if (option.detail?.hint !== undefined) expect(user).toContain(option.detail.hint);
          for (const choice of option.detail?.choices ?? []) {
            expect(user).toContain(`${JSON.stringify(choice.value)} (${choice.label})`);
          }
        }
      }
      // Instructions inside the material stay material.
      if (call.part === "A") expect(user).toContain("Ignore all previous instructions");
    }
  });

  test("reject answers the survey would reject, and never repair them", async () => {
    const cases: Array<[string, (ids: string[], part: string) => unknown, string]> = [
      ["not JSON", () => "Here is my answer", "not one JSON object"],
      [
        "a fenced reply",
        (ids, part) => "```json\n" + JSON.stringify(validAnswers(ids, part)) + "\n```",
        "not one JSON object",
      ],
      [
        "an unknown option",
        () => ({ answers: { SPEC: { value: "fine" } } }),
        "SPEC has an option that does not exist",
      ],
      ["a readiness level as text", () => ({ answers: { SPEC: { value: "clear" } } }), ""],
      [
        "a missing follow-up choice",
        () => ({
          answers: { SPEC: { value: "clarify", text: "x", evidence_refs: ["statement:L1"] } },
        }),
        "SPEC needs one of the follow-up choices",
      ],
      [
        "a missing detail",
        () => ({
          answers: { SPEC: { value: "cannot_assess", evidence_refs: ["material:template"] } },
        }),
        "SPEC needs “What’s missing?”",
      ],
      [
        "an item of another part",
        () => ({ answers: { SPEC: { value: "clear" }, RD1: { value: 5 } } }),
        "RD1 is not part of this section",
      ],
      [
        "an extra field",
        () => ({ answers: { SPEC: { value: "clear", confidence: 0.9 } } }),
        "answers.SPEC",
      ],
    ];
    for (const [name, make, issue] of cases) {
      const transport = new ScriptedTransport((messages) => {
        if (partOf(messages) !== "A") {
          return reply(JSON.stringify(validAnswers(askedItems(messages), partOf(messages))));
        }
        const made = make(askedItems(messages), partOf(messages));
        return reply(typeof made === "string" ? made : JSON.stringify(made));
      });
      const judgement = await judgeExercise(synthetic, instrument, transport, options);
      const a = judgement.calls[0];
      if (name === "a readiness level as text") {
        // Control: a plain valid answer is accepted.
        expect(a?.status).toBe("answered");
        continue;
      }
      expect({ name, status: a?.status }).toEqual({ name, status: "invalid_output" });
      expect(a?.issues.join("\n")).toContain(issue);
      expect(a?.answers).toBeNull();
      expect(judgement.rows[0]).toMatchObject({
        item_id: "SPEC",
        status: "invalid_output",
        answer: null,
      });
      // A single attempt: invalid output is not retried.
      expect(a?.attempts).toHaveLength(1);
    }
  });

  test("reject an invalid RD1 while still rating RD2", async () => {
    const transport = new ScriptedTransport((messages) => {
      const ids = askedItems(messages);
      if (ids.includes("RD1")) {
        const answers = validAnswers(ids, "C");
        (answers.answers as Record<string, { value: unknown }>).RD1 = { value: "5" };
        return reply(JSON.stringify(answers));
      }
      return reply(JSON.stringify(validAnswers(ids, partOf(messages))));
    });
    const judgement = await judgeExercise(synthetic, instrument, transport, options);
    expect(judgement.calls.map((call) => call.status)).toEqual([
      "answered",
      "answered",
      "invalid_output",
      "answered",
    ]);
    expect(judgement.calls[2]?.issues).toContain("RD1 has an option that does not exist");
    expect(transport.calls).toHaveLength(4);
    expect(judgement.rows.find((row) => row.item_id === "RD2")?.status).toBe("answered");
  });

  test("keep a valid Cannot assess apart from errors", async () => {
    const transport = new ScriptedTransport((messages) => {
      const ids = askedItems(messages);
      if (ids.includes("SPEC")) {
        return reply(
          JSON.stringify({
            answers: {
              SPEC: {
                value: "cannot_assess",
                text: "The diagram does not render.",
                evidence_refs: ["statement:L5-L12"],
              },
            },
          }),
        );
      }
      return reply(JSON.stringify(validAnswers(ids, partOf(messages))));
    });
    const judgement = await judgeExercise(synthetic, instrument, transport, options);
    expect(judgement.rows[0]).toMatchObject({
      status: "answered",
      answer: { value: "cannot_assess", text: "The diagram does not render." },
      evidence_refs: ["statement:L5-L12"],
    });
  });

  test("flags citations to an unopened setup file and keeps the rating", async () => {
    const transport = new ScriptedTransport((messages) => {
      const ids = askedItems(messages);
      if (ids.includes("SPEC")) {
        return reply(
          JSON.stringify({
            answers: {
              SPEC: { value: "clear", evidence_refs: ["file:build.gradle:L1"] },
            },
          }),
        );
      }
      return reply(JSON.stringify(validAnswers(ids, partOf(messages))));
    });
    const result = await judgeExercise(synthetic, instrument, transport, options);
    expect(result.rows[0]).toMatchObject({
      item_id: "SPEC",
      status: "answered",
      answer: { value: "clear" },
      evidence_issues: ["file:build.gradle is not available at this stage"],
    });
  });

  test("retry technical failures only, and record model errors", async () => {
    let failed = false;
    const flaky = new ScriptedTransport((messages) => {
      if (!failed) {
        failed = true;
        throw new TransportError("HTTP 503: busy", true, 503);
      }
      return reply(JSON.stringify(validAnswers(askedItems(messages), partOf(messages))));
    });
    const recovered = await judgeExercise(synthetic, instrument, flaky, options);
    expect(recovered.calls[0]?.status).toBe("answered");
    expect(recovered.calls[0]?.attempts.map((attempt) => attempt.outcome)).toEqual([
      "error",
      "completion",
    ]);

    const scenarios: Array<[string, () => Completion, string]> = [
      [
        "refused",
        () => {
          throw new TransportError("HTTP 401: unauthorized", false, 401);
        },
        "HTTP 401",
      ],
      ["empty", () => reply(""), "no content"],
      ["cut off", () => reply('{"answers": {', { finishReason: "length" }), "cut off"],
    ];
    for (const [, behave, issue] of scenarios) {
      const transport = new ScriptedTransport(() => behave());
      const judgement = await judgeExercise(synthetic, instrument, transport, options);
      expect(judgement.calls.map((call) => call.status)).toEqual([
        "model_error",
        "model_error",
        "model_error",
        "model_error",
      ]);
      expect(judgement.calls[0]?.issues.join()).toContain(issue);
      expect(judgement.rows.every((row) => row.answer === null)).toBe(true);
    }
    const down = new ScriptedTransport(() => {
      throw new TransportError("request failed: TimeoutError", true);
    });
    const judgement = await judgeExercise(synthetic, instrument, down, options);
    expect(judgement.calls[0]?.attempts).toHaveLength(2);
  });

  test("let a stage read its own closed setup files once, and nothing else", async () => {
    const reading = new ScriptedTransport((messages) => {
      if (partOf(messages) === "A" && messages.length === 2) {
        return reply(JSON.stringify({ read_setup_files: ["build.gradle"] }));
      }
      return reply(JSON.stringify(validAnswers(askedItems(messages), partOf(messages))));
    });
    const judgement = await judgeExercise(synthetic, instrument, reading, options);
    const a = judgement.calls[0];
    expect(a?.status).toBe("answered");
    expect(a?.setup_files_read).toEqual(["build.gradle"]);
    expect(a?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(a?.messages[3]?.content).toContain("SENTINEL_SETUP_CONTENT");
    // The read stays inside its stage's conversation.
    expect(allPrompts(judgement, "B")).not.toContain("SENTINEL_SETUP_CONTENT");

    for (const paths of [
      ["settings.gradle"],
      ["src/de/tum/cit/aet/log/TemperatureLog.java"],
      ["secret.txt"],
      ["build.gradle", "build.gradle"],
    ]) {
      const transport = new ScriptedTransport((messages) =>
        partOf(messages) === "A"
          ? reply(JSON.stringify({ read_setup_files: paths }))
          : reply(JSON.stringify(validAnswers(askedItems(messages), partOf(messages)))),
      );
      const rejected = await judgeExercise(synthetic, instrument, transport, options);
      expect(rejected.calls[0]?.status).toBe("invalid_output");
      expect(rejected.calls[0]?.setup_files_read).toEqual([]);
    }
    const twice = new ScriptedTransport((messages) =>
      partOf(messages) === "A"
        ? reply(JSON.stringify({ read_setup_files: ["gradlew"] }))
        : reply(JSON.stringify(validAnswers(askedItems(messages), partOf(messages)))),
    );
    const again = await judgeExercise(synthetic, instrument, twice, options);
    expect(again.calls[0]?.issues).toContain("asked for setup files when no request was offered");

    const off = await judgeExercise(synthetic, instrument, validTransport(), {
      ...options,
      setupReads: { enabled: false, maxFiles: 4 },
    });
    expect(off.calls[0]?.messages[1]?.content).not.toContain("read_setup_files");
  });

  test("judge the real-format study exercises without facts or IDs in any prompt", async () => {
    const exercises = await loadExercises([], [REAL_EXERCISES]);
    expect(exercises.map((exercise) => exercise.id).sort()).toEqual(["BD2N", "J7DZ", "QD9F"]);
    for (const exercise of exercises) {
      const judgement = await judgeExercise(exercise, instrument, validTransport(), options);
      expect(judgement.calls.every((call) => call.status === "answered")).toBe(true);
      const prompts = judgement.calls
        .flatMap((call) => call.messages.map((message) => message.content))
        .join("\n");
      expect(prompts).not.toContain(exercise.id);
      const a = allPrompts(judgement, "A");
      expect(a).not.toContain(exercise.brief.split("\n")[0] ?? "");
      expect(a).not.toContain("Solution changes");
    }
  });
});

describe("OpenAI-compatible transport and run records", () => {
  test("call a local OpenAI-compatible endpoint end to end, with no credential in any record", async () => {
    const key = "test-credential-7f3c9a";
    const seen: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
    let first = true;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { messages: ChatMessage[] } & Record<
          string,
          unknown
        >;
        seen.push({ authorization: request.headers.get("authorization"), body });
        if (first) {
          first = false;
          return Response.json({ error: { message: `overloaded ${key}` } }, { status: 503 });
        }
        return Response.json({
          id: `chatcmpl-${seen.length}`,
          model: "fake-provider-model-2026-11-01",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify(
                  validAnswers(askedItems(body.messages), partOf(body.messages)),
                ),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    try {
      const config = judgeConfigSchema.parse({
        schema_version: "1",
        provider: {
          base_url: `http://127.0.0.1:${server.port}/v1`,
          api_key_env: "EXGEN_JUDGE_TEST_KEY",
        },
        model: "requested-model",
        seed: 7,
      });
      const output = join(await scratch(), "out");
      const [judgement] = await runJudge({
        exercises: [synthetic],
        instrument,
        transport: new OpenAiCompatibleTransport(config, key),
        config,
        output,
        retryDelayMs: 0,
      });
      expect(judgement?.calls.map((call) => call.status)).toEqual(Array(4).fill("answered"));
      expect(seen[0]?.authorization).toBe(`Bearer ${key}`);
      expect(seen[0]?.body).toMatchObject({
        model: "requested-model",
        temperature: 0,
        seed: 7,
        response_format: { type: "json_object" },
      });
      const a = judgement?.calls[0];
      expect(a?.attempts[0]).toMatchObject({ outcome: "error", http_status: 503, retryable: true });
      expect(a?.attempts[0]?.error).toContain("[credential]");
      expect(a?.attempts[1]).toMatchObject({
        provider_request_id: "chatcmpl-2",
        model: "fake-provider-model-2026-11-01",
      });

      expect((await readdir(output)).sort()).toEqual([
        "ZQ7X.judgement.json",
        "rows.jsonl",
        "run.json",
      ]);
      const written = await Promise.all(
        ["ZQ7X.judgement.json", "rows.jsonl", "run.json"].map((name) =>
          readFile(join(output, name), "utf8"),
        ),
      );
      for (const content of written) expect(content).not.toContain(key);
      const rows = (written[1] ?? "")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { status: string });
      expect(rows).toHaveLength(6);
      const run = JSON.parse(written[2] ?? "{}") as Record<string, unknown>;
      expect(run).toMatchObject({
        rubric_version: "7",
        rows_sha256: sha256(written[1] ?? ""),
        presentation: { text: "staged-text-5", findings: "evidence-v1" },
        transport: {
          kind: "openai-compatible",
          requested_model: "requested-model",
          provider: `127.0.0.1:${server.port}`,
        },
        call_statuses: { answered: 4 },
      });
      const configPath = join(await scratch(), "judge.yaml");
      await writeFile(configPath, JSON.stringify(config));
      const apiKey = process.env.EXGEN_JUDGE_TEST_KEY;
      process.env.EXGEN_JUDGE_TEST_KEY = key;
      try {
        await expect(
          stagedJudgeCli([
            "judge",
            "--config",
            configPath,
            "--exercise",
            "tests/fixtures/staged-judge/synthetic-exercise.json",
            "--output",
            join(await scratch(), "cli"),
            "--model",
            "cli-model",
            "--base-url",
            config.provider.base_url,
          ]),
        ).resolves.toBe(0);
        expect(seen.at(-1)?.body.model).toBe("cli-model");
      } finally {
        if (apiKey === undefined) delete process.env.EXGEN_JUDGE_TEST_KEY;
        else process.env.EXGEN_JUDGE_TEST_KEY = apiKey;
      }
      await expect(
        runJudge({
          exercises: [synthetic],
          instrument,
          transport: validTransport(),
          config,
          output,
        }),
      ).rejects.toThrow("is not empty");
    } finally {
      await server.stop(true);
    }
  });

  test("the command line previews prompts without a model and refuses to judge without a credential", async () => {
    const cli = resolve("tools/tier2-judge/llm-judge/staged/cli.ts");
    const directory = await scratch();
    await expect(
      stagedJudgeCli([
        "preview",
        "--exercises",
        REAL_EXERCISES,
        "--output",
        join(directory, "preview"),
      ]),
    ).resolves.toBe(0);
    expect((await readdir(join(directory, "preview"))).sort()).toEqual(["BD2N", "J7DZ", "QD9F"]);
    expect((await readdir(join(directory, "preview", "BD2N"))).sort()).toEqual([
      "A.md",
      "B.md",
      "C.md",
      "D-RD2.md",
      "system.md",
    ]);

    const env = { ...process.env };
    delete env.EXGEN_JUDGE_API_KEY;
    const judge = Bun.spawnSync(
      [
        process.execPath,
        "run",
        cli,
        "judge",
        "--config",
        "tools/tier2-judge/llm-judge/staged/judge.example.yaml",
        "--exercises",
        REAL_EXERCISES,
        "--output",
        join(directory, "judge"),
      ],
      { env },
    );
    expect(judge.exitCode).toBe(1);
    expect(judge.stderr.toString()).toContain("EXGEN_JUDGE_API_KEY");

    await expect(
      stagedJudgeCli([
        "preview",
        "--instrument-version",
        "99",
        "--output",
        join(directory, "other"),
      ]),
    ).rejects.toThrow("instrument 99 does not exist");
  });
});
