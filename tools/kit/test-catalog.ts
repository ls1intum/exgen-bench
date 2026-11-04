import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { resolveContained } from "../../src/adapters/paths.ts";

/**
 * The test cases of the Artemis exercise version a candidate was saved as, which the Artemis
 * adapter records next to the artifacts as generation evidence. A candidate from another system has
 * no such evidence.
 */
export interface CatalogTest {
  id: number;
  name: string;
  /** Artemis's test type: STRUCTURAL, BEHAVIORAL or MIXED; null when the evidence omits it. */
  type: string | null;
  weight: number | null;
  bonusPoints: number | null;
  /** Artemis's visibility: ALWAYS, AFTER_DUE_DATE or NEVER; null when the evidence omits it. */
  visibility: string | null;
  /** Whether the latest build reported the test; Artemis scores active tests only. */
  active: boolean;
}

/**
 * Structural tests check the declared shape that the template's stubs already satisfy. Gradable
 * tests are the other tests a student earns points with, as Artemis scores them
 * (`ProgrammingExerciseGradingService`, `TestCasePointsService`): a test whose visibility is not
 * NEVER, with a weight or bonus points above 0. Preservation tests are the remaining non-structural
 * tests, which award nothing: they check given code and pass on both repositories by design.
 * Inactive tests, which Artemis does not score at all, are not in the catalog this module returns.
 */
export type TestLane = "structural" | "preservation" | "gradable";

export const TEST_LANES = ["gradable", "structural", "preservation"] as const;

const responseSchema = z.looseObject({
  extensions: z
    .looseObject({
      artemis: z.looseObject({ evidence_path: z.string().min(1).optional() }).optional(),
    })
    .optional(),
});

const evidenceSchema = z.looseObject({
  exact_version: z.looseObject({
    programmingData: z.looseObject({
      testCases: z.array(
        z.looseObject({
          id: z.number().int(),
          testName: z.string().min(1),
          type: z.string().min(1).optional(),
          weight: z.number().finite().optional(),
          bonusPoints: z.number().finite().optional(),
          visibility: z.string().min(1).optional(),
          active: z.boolean().optional(),
        }),
      ),
    }),
  }),
});

async function readEvidenceTests(bundlePath: string) {
  const response = responseSchema.parse(
    JSON.parse(await readFile(join(bundlePath, "response.json"), "utf8")),
  );
  const evidence = response.extensions?.artemis?.evidence_path;
  if (evidence === undefined) return null;
  const { exact_version } = evidenceSchema.parse(
    JSON.parse(await readFile(resolveContained(bundlePath, evidence, "evidence"), "utf8")),
  );
  return exact_version.programmingData.testCases;
}

/**
 * Every test of the catalog by ID, inactive ones included, as statements reference them with
 * `<testid>N</testid>`; null when the candidate carries no Artemis generation evidence. Only the ID
 * and name are required.
 */
export async function readTestNames(bundlePath: string): Promise<Map<number, string> | null> {
  const tests = await readEvidenceTests(bundlePath);
  return tests === null ? null : new Map(tests.map((test) => [test.id, test.testName]));
}

/**
 * The active tests of the catalog, or null when the candidate carries no Artemis generation
 * evidence. A test without an `active` flag counts as active.
 */
export async function readTestCatalog(bundlePath: string): Promise<CatalogTest[] | null> {
  const tests = await readEvidenceTests(bundlePath);
  if (tests === null) return null;
  return tests
    .filter((test) => test.active !== false)
    .map((test) => ({
      id: test.id,
      name: test.testName,
      type: test.type ?? null,
      weight: test.weight ?? null,
      bonusPoints: test.bonusPoints ?? null,
      visibility: test.visibility ?? null,
      active: true,
    }));
}

/** A test's lane, or null when the catalog lacks a field that decides it. */
export function testLane(test: CatalogTest): TestLane | null {
  if (test.type === "STRUCTURAL") return "structural";
  if (
    test.type === null ||
    test.weight === null ||
    test.bonusPoints === null ||
    test.visibility === null
  ) {
    return null;
  }
  const credit =
    test.active && test.visibility !== "NEVER" && (test.weight > 0 || test.bonusPoints > 0);
  return credit ? "gradable" : "preservation";
}
