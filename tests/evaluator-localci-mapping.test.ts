import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { submissionBuildSchema } from "../evaluators/java-oracle/backend.ts";
import { buildRecordingSchema } from "../evaluators/java-oracle/fixture-backend.ts";
import { toSubmissionBuild } from "../evaluators/java-oracle/localci-backend.ts";

/**
 * The parsing boundary the fixture corpus used to leave uncovered.
 *
 * `oracle-recordings/` encodes the backend-agnostic `BuildOutcome` that the fixture backend replays,
 * so it sits *below* `toSubmissionBuild` and cannot say whether Artemis's own answer maps onto that
 * outcome. `localci-recordings/` holds raw Artemis result payloads for the same cases, and this suite
 * asserts the two agree. Without it the fixture and LocalCI backends could disagree about the same
 * build and no fixture would notice — which is exactly what M2 has to rule out.
 *
 * These payloads are hand-authored against `resultSchema`, not captured: no committed run contains a
 * build result, because Hyperion generation never triggers a template or solution build. So a green
 * run here means the evaluator is self-consistent, never that the endpoint contract is verified. See
 * `evaluators/fixtures/localci-recordings/README.md`.
 */

const FIXTURES = resolve(import.meta.dir, "../evaluators/fixtures");
const LOCALCI = join(FIXTURES, "localci-recordings");
const ORACLE = join(FIXTURES, "oracle-recordings");

/**
 * The recorded payloads, in the shapes Artemis really uses: the result nested under a submission
 * (which is where `buildFailed` lives) and the feedbacks alongside, because the result itself never
 * carries them -- they come from the separate details endpoint.
 *
 * This is strict on purpose. A loose schema here would let a recording drift back to the flat
 * `Result`-with-inline-`feedbacks` shape that Artemis does not produce, and the mapping test would
 * keep passing while asserting nothing about the real contract.
 */
const recordedBuildSchema = z
  .object({
    submission: z
      .object({
        id: z.number().int().positive(),
        buildFailed: z.boolean(),
        commitHash: z.string().nullable(),
      })
      .strict(),
    result: z
      .object({
        id: z.number().int().positive(),
        completionDate: z.string().min(1),
        successful: z.boolean().optional(),
        score: z.number().optional(),
        testCaseCount: z.number().int().optional(),
        passedTestCaseCount: z.number().int().optional(),
        codeIssueCount: z.number().int().optional(),
      })
      .strict(),
    feedbacks: z.array(z.looseObject({})),
  })
  .strict();

const rawPairSchema = z
  .object({ template: recordedBuildSchema, solution: recordedBuildSchema })
  .strict();

const cases = (await readdir(LOCALCI))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""))
  .sort();

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("LocalCI result payloads map onto the recorded build outcomes", () => {
  test("every raw recording has a build outcome to agree with", () => {
    expect(cases.length).toBeGreaterThan(0);
    // `non-terminating-test` is deliberately absent: no result ever completes, so there is no
    // payload to map and the case is an infrastructure failure by construction.
    expect(cases).not.toContain("non-terminating-test");
  });

  for (const caseId of cases) {
    test(`${caseId}`, async () => {
      const raw = rawPairSchema.parse(await readJson(join(LOCALCI, `${caseId}.json`)));
      const recorded = buildRecordingSchema.parse(await readJson(join(ORACLE, `${caseId}.json`)));
      if ("infrastructure_failure" in recorded) {
        throw new Error(
          `${caseId} records an infrastructure failure, which has no build result to map`,
        );
      }

      for (const side of ["template", "solution"] as const) {
        const mapped = toSubmissionBuild(raw[side]);
        expect(submissionBuildSchema.parse(mapped), `${caseId} ${side}`).toEqual(recorded[side]);
      }
    });
  }

  test("coverage is unreachable through this backend, in both dimensions, for every case", async () => {
    // Artemis removed test-wise coverage (#9993) and `Result` carries no aggregate coverage field,
    // so a recording that asserted any coverage number would be asserting something this backend
    // cannot produce. Pinning it stops that drifting back in.
    for (const caseId of cases) {
      const raw = rawPairSchema.parse(await readJson(join(LOCALCI, `${caseId}.json`)));
      for (const side of ["template", "solution"] as const) {
        expect(toSubmissionBuild(raw[side]).coverage, `${caseId} ${side}`).toBeNull();
      }
    }
  });

  test("the mapping notices a feedback set that does not belong to the build", async () => {
    // A negative control: the assertions above compare a mapping to a recorded outcome, so they are
    // only meaningful if a wrong input actually changes the answer.
    const raw = rawPairSchema.parse(await readJson(join(LOCALCI, "correct-exercise.json")));
    const swapped = toSubmissionBuild({ ...raw.solution, feedbacks: raw.template.feedbacks });
    expect(swapped.test_cases.every((testCase) => testCase.passed)).toBe(false);
    expect(swapped).not.toEqual(toSubmissionBuild(raw.solution));
  });

  test("a compile failure maps to no executed tests and no pass rate", async () => {
    const raw = rawPairSchema.parse(
      await readJson(join(LOCALCI, "solution-does-not-compile.json")),
    );
    const mapped = toSubmissionBuild(raw.solution);
    expect(mapped.compiled).toBe(false);
    expect(mapped.tests_executed).toBe(false);
    expect(mapped.test_cases).toEqual([]);
    // A build that fails to compile carries no feedbacks at all through the results API -- the
    // compiler's output lives only in the build logs. `buildFailed` on the submission is the whole
    // signal, and inventing a diagnostic from anything else would be inventing evidence.
    expect(mapped.diagnostics).toEqual([]);
  });

  test("the template's test cases survive a solution build that never established them", async () => {
    // When the solution build fails, the exercise's test cases are never registered, so the
    // template's feedbacks name their test in `text` with no `testCase` relation. Reading only the
    // relation loses the whole suite and reports the template as running no tests.
    const raw = rawPairSchema.parse(
      await readJson(join(LOCALCI, "solution-does-not-compile.json")),
    );
    expect(raw.template.feedbacks.every((feedback) => !("testCase" in (feedback as object)))).toBe(
      true,
    );
    const mapped = toSubmissionBuild(raw.template);
    expect(mapped.test_cases.map((testCase) => testCase.name)).toEqual([
      "returnsZeroForAnEmptyArray",
      "sumsEvenValues",
      "handlesNegativeEvenValues",
    ]);
    expect(mapped.tests_executed).toBe(true);
    expect(mapped.diagnostics).toEqual([]);
  });

  test("a build remark without an outcome stays a diagnostic, not a test case", async () => {
    // The `text` fallback only applies to feedbacks that state whether they passed. Without that,
    // any build remark carrying text would be counted as a test and inflate the suite size.
    const remark = toSubmissionBuild({
      submission: { id: 1, buildFailed: false },
      result: { id: 1, completionDate: "2026-08-10T00:00:00Z" },
      feedbacks: [{ type: "AUTOMATIC", text: "EvenSum.java:[18,29] cannot find symbol" }],
    });
    expect(remark.test_cases).toEqual([]);
    expect(remark.diagnostics).toEqual(["EvenSum.java:[18,29] cannot find symbol"]);
  });

  test("a denied file read is a failing test, not a harness abort", async () => {
    // The sandbox denies the read and reports it as an ordinary failing test case; it does not
    // abort the suite. So the build compiles, the suite runs, and the exercise is rejected because
    // the solution cannot pass its own test -- not because nothing executed.
    const raw = rawPairSchema.parse(
      await readJson(join(LOCALCI, "test-reads-forbidden-file.json")),
    );
    for (const side of ["template", "solution"] as const) {
      const mapped = toSubmissionBuild(raw[side]);
      expect(mapped.compiled).toBe(true);
      expect(mapped.tests_executed).toBe(true);
      expect(mapped.diagnostics).toEqual([]);
      const denied = mapped.test_cases.find(
        (testCase) => testCase.name === "readsTheExpectedTotalsFromDisk",
      );
      expect(denied?.passed).toBe(false);
      expect(denied?.message).toContain("/etc/exgen/expected-totals.txt");
    }
    // The solution passes only the test that does not touch the filesystem, so the gate rejects it.
    expect(toSubmissionBuild(raw.solution).test_cases.filter((entry) => entry.passed)).toHaveLength(
      1,
    );
  });
});
