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

const rawPairSchema = z
  .object({ template: z.looseObject({}), solution: z.looseObject({}) })
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
        const mapped = toSubmissionBuild(raw[side] as never);
        expect(submissionBuildSchema.parse(mapped), `${caseId} ${side}`).toEqual(recorded[side]);
      }
    });
  }

  test("branch coverage is unreachable through this endpoint, for every case", async () => {
    // `coverageFrom` reads line counts only, so a recording that asserted a branch number would be
    // asserting something the backend cannot produce. Pinning it stops that drifting back in.
    for (const caseId of cases) {
      const raw = rawPairSchema.parse(await readJson(join(LOCALCI, `${caseId}.json`)));
      for (const side of ["template", "solution"] as const) {
        const mapped = toSubmissionBuild(raw[side] as never);
        expect(mapped.coverage?.branch ?? null, `${caseId} ${side}`).toBeNull();
      }
    }
  });

  test("a compile failure maps to no executed tests and no pass rate", async () => {
    const raw = rawPairSchema.parse(
      await readJson(join(LOCALCI, "solution-does-not-compile.json")),
    );
    const mapped = toSubmissionBuild(raw.solution as never);
    expect(mapped.compiled).toBe(false);
    expect(mapped.tests_executed).toBe(false);
    expect(mapped.test_cases).toEqual([]);
    // The compiler's complaint survives as a diagnostic rather than as a failing test case.
    expect(mapped.diagnostics.length).toBeGreaterThan(0);
  });

  test("a denied file read leaves a compiled build with no executed tests", async () => {
    const raw = rawPairSchema.parse(
      await readJson(join(LOCALCI, "test-reads-forbidden-file.json")),
    );
    for (const side of ["template", "solution"] as const) {
      const mapped = toSubmissionBuild(raw[side] as never);
      expect(mapped.compiled).toBe(true);
      expect(mapped.tests_executed).toBe(false);
      expect(mapped.diagnostics.join(" ")).toContain("AccessDeniedException");
    }
  });
});
