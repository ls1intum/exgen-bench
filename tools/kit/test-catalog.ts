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
}

/**
 * Structural tests check the declared shape that the template's stubs already satisfy. Preservation
 * tests are non-structural tests with weight 0: they check given code and must pass on both
 * repositories by design. Gradable tests are the rest, the tests a student earns points with.
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
        }),
      ),
    }),
  }),
});

/** The catalog, or null when the candidate carries no Artemis generation evidence. */
export async function readTestCatalog(bundlePath: string): Promise<CatalogTest[] | null> {
  const response = responseSchema.parse(
    JSON.parse(await readFile(join(bundlePath, "response.json"), "utf8")),
  );
  const evidence = response.extensions?.artemis?.evidence_path;
  if (evidence === undefined) return null;
  const { exact_version } = evidenceSchema.parse(
    JSON.parse(await readFile(resolveContained(bundlePath, evidence, "evidence"), "utf8")),
  );
  return exact_version.programmingData.testCases.map((test) => ({
    id: test.id,
    name: test.testName,
    type: test.type ?? null,
    weight: test.weight ?? null,
    bonusPoints: test.bonusPoints ?? null,
  }));
}

/** A test's lane, or null when the catalog lacks the type or weight that decide it. */
export function testLane(test: CatalogTest): TestLane | null {
  if (test.type === "STRUCTURAL") return "structural";
  if (test.type === null || test.weight === null) return null;
  return test.weight > 0 ? "gradable" : "preservation";
}
