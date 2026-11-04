import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CatalogTest,
  readTestCatalog,
  readTestNames,
  testLane,
} from "../tools/kit/test-catalog.ts";
import type { BuildOutcome } from "../tools/tier1-deterministic/java-oracle/backend.ts";
import {
  assignLanes,
  gradableVerdict,
  laneScores,
  oracleVerdict,
} from "../tools/tier1-deterministic/java-oracle/evaluate.ts";
import { generationRecord } from "../tools/tier3-expert-rating/builder/build.ts";

const catalogTest = (
  name: string,
  type: string,
  weight: number,
  id = name.length,
): CatalogTest => ({
  id,
  name,
  type,
  weight,
  bonusPoints: 0,
  visibility: "ALWAYS",
  active: true,
});

const CATALOG = [
  catalogTest("testClass[Book]", "STRUCTURAL", 1),
  catalogTest("freshPlayerHasVolumeZero", "BEHAVIORAL", 0),
  catalogTest("labelJoinsTitleAndAuthor", "BEHAVIORAL", 2),
  catalogTest("equalIsbnMeansEqualBooks", "BEHAVIORAL", 1),
];

function build(cases: Array<[string, boolean]>) {
  return {
    compiled: true,
    tests_executed: true,
    coverage: null,
    diagnostics: [],
    test_cases: cases.map(([name, passed]) => ({ name, passed })),
  };
}

function outcome(template: Array<[string, boolean]>, solution: Array<[string, boolean]>) {
  return {
    template: build(template),
    solution: build(solution),
    attestation: {
      backend_id: "test",
      artemis_revision: null,
      build_agent_image: null,
      build_script_revision: null,
      toolchain: null,
      build_phase_scripts: [],
      build_branch: null,
      unattested: [],
    },
  } satisfies BuildOutcome;
}

// The reproduction from #57: the template passes only the structural and the preservation test.
const ISSUE_57 = outcome(
  [
    ["testClass[Book]", true],
    ["freshPlayerHasVolumeZero", true],
    ["labelJoinsTitleAndAuthor", false],
    ["equalIsbnMeansEqualBooks", false],
  ],
  [
    ["testClass[Book]", true],
    ["freshPlayerHasVolumeZero", true],
    ["labelJoinsTitleAndAuthor", true],
    ["equalIsbnMeansEqualBooks", true],
  ],
);

function lanesOf(result: ReturnType<typeof assignLanes>) {
  if ("unavailable" in result) throw new Error(result.unavailable);
  return result.lanes;
}

describe("test lanes", () => {
  test("structural by type, preservation by zero weight, gradable otherwise", () => {
    expect(CATALOG.map(testLane)).toEqual(["structural", "preservation", "gradable", "gradable"]);
    expect(testLane({ ...catalogTest("x", "BEHAVIORAL", 1), weight: null })).toBe(null);
    expect(testLane({ ...catalogTest("x", "BEHAVIORAL", 1), visibility: null })).toBe(null);
  });

  test("follow Artemis scoring: bonus points earn credit, NEVER and inactive tests do not", () => {
    expect(testLane({ ...catalogTest("x", "BEHAVIORAL", 0), bonusPoints: 2 })).toBe("gradable");
    expect(testLane({ ...catalogTest("x", "BEHAVIORAL", 3), visibility: "NEVER" })).toBe(
      "preservation",
    );
    expect(testLane({ ...catalogTest("x", "BEHAVIORAL", 3), visibility: "AFTER_DUE_DATE" })).toBe(
      "gradable",
    );
    expect(testLane({ ...catalogTest("x", "BEHAVIORAL", 3), active: false })).toBe("preservation");
    expect(testLane(catalogTest("x", "MIXED", 1))).toBe("gradable");
  });

  test("the #57 template is rejected by the strict gate and accepted by the gradable one", () => {
    expect(oracleVerdict(ISSUE_57).satisfied).toBe(false);
    expect(gradableVerdict(ISSUE_57, lanesOf(assignLanes(ISSUE_57, CATALOG)))).toEqual({
      satisfied: true,
      reasons: [],
    });
  });

  test("a template that passes a gradable test fails the gradable gate", () => {
    const leaky = outcome(
      [
        ["testClass[Book]", true],
        ["freshPlayerHasVolumeZero", true],
        ["labelJoinsTitleAndAuthor", true],
        ["equalIsbnMeansEqualBooks", false],
      ],
      ISSUE_57.solution.test_cases.map((testCase) => [testCase.name, true]),
    );
    const verdict = gradableVerdict(leaky, lanesOf(assignLanes(leaky, CATALOG)));
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons).toEqual([
      "the template already passes 1 gradable tests: labelJoinsTitleAndAuthor",
    ]);
  });

  test("the solution must still pass every lane, and every gradable test must run", () => {
    const failing = outcome(
      [["labelJoinsTitleAndAuthor", false]],
      [
        ["freshPlayerHasVolumeZero", false],
        ["labelJoinsTitleAndAuthor", true],
      ],
    );
    const verdict = gradableVerdict(failing, lanesOf(assignLanes(failing, CATALOG)));
    expect(verdict.reasons).toContain("the solution passes 1 of 2 tests, not all of them");
    expect(verdict.reasons).toContain(
      "gradable tests did not run against the solution: equalIsbnMeansEqualBooks",
    );
  });

  test("lanes fail closed: no catalog, an unknown lane or an unlisted test", () => {
    expect(assignLanes(ISSUE_57, null)).toMatchObject({
      unavailable: expect.stringContaining("no Artemis test catalog"),
    });
    expect(
      assignLanes(ISSUE_57, [...CATALOG, { ...catalogTest("x", "BEHAVIORAL", 1), type: null }]),
    ).toMatchObject({
      unavailable: expect.stringContaining("no type, weight, bonus points or visibility for x"),
    });
    expect(assignLanes(ISSUE_57, CATALOG.slice(1))).toMatchObject({
      unavailable: "1 executed tests are not in the test catalog: testClass[Book]",
    });
  });

  test("report the template pass rate per lane and the gradable verdict", () => {
    const scores = laneScores(ISSUE_57, assignLanes(ISSUE_57, CATALOG));
    const byId = Object.fromEntries(scores.map((entry) => [entry.metric_id, entry]));
    expect(byId["oracle.gradable_satisfied"]).toMatchObject({ status: "ok", value: true });
    expect(byId["oracle.template_pass_rate_gradable"]).toMatchObject({
      value: 0,
      numerator: 0,
      denominator: 2,
    });
    expect(byId["oracle.template_pass_rate_structural"]).toMatchObject({
      value: 1,
      denominator: 1,
    });
    expect(byId["oracle.template_pass_rate_preservation"]).toMatchObject({
      value: 1,
      evidence: ["passes:freshPlayerHasVolumeZero"],
    });
    const unavailable = laneScores(ISSUE_57, assignLanes(ISSUE_57, null));
    expect(unavailable.every((entry) => entry.status === "not_applicable")).toBe(true);
  });
});

describe("the Artemis test catalog", () => {
  test("is read from the generation evidence the response points at", async () => {
    const bundle = await mkdtemp(join(tmpdir(), "exgen-catalog-"));
    try {
      await mkdir(join(bundle, "artemis"));
      await writeFile(
        join(bundle, "response.json"),
        JSON.stringify({
          status: "succeeded",
          extensions: { artemis: { evidence_path: "artemis/generation-evidence.json" } },
        }),
      );
      await writeFile(
        join(bundle, "artemis/generation-evidence.json"),
        JSON.stringify({
          exact_version: {
            programmingData: {
              testCases: [
                {
                  id: 7,
                  testName: "printsSongLine",
                  type: "BEHAVIORAL",
                  weight: 1,
                  bonusPoints: 0,
                  visibility: "ALWAYS",
                  active: true,
                },
                { id: 8, testName: "testClass[Book]", type: "STRUCTURAL", weight: 0 },
                {
                  id: 9,
                  testName: "removedTest",
                  type: "BEHAVIORAL",
                  weight: 1,
                  bonusPoints: 0,
                  visibility: "ALWAYS",
                  active: false,
                },
              ],
            },
          },
        }),
      );
      expect(await readTestCatalog(bundle)).toEqual([
        {
          id: 7,
          name: "printsSongLine",
          type: "BEHAVIORAL",
          weight: 1,
          bonusPoints: 0,
          visibility: "ALWAYS",
          active: true,
        },
        {
          id: 8,
          name: "testClass[Book]",
          type: "STRUCTURAL",
          weight: 0,
          bonusPoints: null,
          visibility: null,
          active: true,
        },
      ]);
      // The survey builder resolves <testid> references, which may name inactive tests too.
      expect(await generationRecord(bundle)).toEqual({
        succeeded: true,
        catalog: new Map([
          [7, "printsSongLine"],
          [8, "testClass[Book]"],
          [9, "removedTest"],
        ]),
      });
      await writeFile(join(bundle, "response.json"), JSON.stringify({ status: "succeeded" }));
      expect(await readTestCatalog(bundle)).toBeNull();
      expect(await readTestNames(bundle)).toBeNull();
      await writeFile(
        join(bundle, "response.json"),
        JSON.stringify({ extensions: { artemis: { evidence_path: "../outside.json" } } }),
      );
      await expect(readTestCatalog(bundle)).rejects.toThrow();
    } finally {
      await rm(bundle, { recursive: true, force: true });
    }
  });
});
