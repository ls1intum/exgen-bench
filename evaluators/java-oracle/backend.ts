import { z } from "zod";
import type { EvaluationRequest } from "../../src/evaluation/contracts.ts";
import type { CandidateBundle } from "../shared/bundle.ts";

/**
 * The build backend boundary.
 *
 * Decision D1 makes Artemis LocalCI the execution oracle and waives evaluator independence for now.
 * That waiver is a configuration choice, not an architecture: everything above this interface is
 * backend-agnostic, so restoring independence later (WP2c, a digest-pinned network-isolated
 * container) is a different `BuildBackend` and a re-run, not a rewrite. The metric contract, the
 * acceptance gate and the fixture corpus are identical across backends by construction.
 */

export const testCaseResultSchema = z
  .object({
    name: z.string().min(1),
    passed: z.boolean(),
    message: z.string().optional(),
  })
  .strict();

export const submissionBuildSchema = z
  .object({
    /** Whether the submission compiled. A compile failure is a quality fact about the candidate. */
    compiled: z.boolean(),
    /** Whether the test suite ran to completion without a harness error. */
    tests_executed: z.boolean(),
    test_cases: z.array(testCaseResultSchema).default([]),
    coverage: z
      .object({
        statement: z.number().min(0).max(1).nullable(),
        branch: z.number().min(0).max(1).nullable(),
      })
      .strict()
      .nullable()
      .default(null),
    diagnostics: z.array(z.string()).max(64).default([]),
  })
  .strict();

/**
 * What the deployment could attest about how the build ran.
 *
 * Every field is nullable on purpose. Artemis attests none of these today (`ARTEMIS-INTEGRATION.md`,
 * "no build revision attestation"), so the evaluator records the gap explicitly rather than omitting
 * the field and letting a reader assume the runs were comparable. Two runs months apart are not
 * comparable while these are null, and the suite manifest has to say so.
 */
export const buildAttestationSchema = z
  .object({
    backend_id: z.string().min(1),
    artemis_revision: z.string().nullable().default(null),
    build_agent_image: z.string().nullable().default(null),
    build_script_revision: z.string().nullable().default(null),
    unattested: z.array(z.string()).default([]),
  })
  .strict();

export const buildOutcomeSchema = z
  .object({
    template: submissionBuildSchema,
    solution: submissionBuildSchema,
    attestation: buildAttestationSchema,
  })
  .strict();

export type TestCaseResult = z.infer<typeof testCaseResultSchema>;
export type SubmissionBuild = z.infer<typeof submissionBuildSchema>;
export type BuildAttestation = z.infer<typeof buildAttestationSchema>;
export type BuildOutcome = z.infer<typeof buildOutcomeSchema>;

export interface BuildJob {
  request: EvaluationRequest;
  bundle: CandidateBundle;
}

export interface BuildBackend {
  readonly id: string;
  /** Build the template and the solution and collect both results. */
  build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome>;
  /**
   * Reconcile or cancel durable remote work for this evaluation. Called by the recovery command; a
   * backend that starts no durable work may omit it.
   */
  recover?(job: BuildJob, signal: AbortSignal): Promise<void>;
}

export function passRate(build: SubmissionBuild): {
  numerator: number;
  denominator: number;
  rate: number | null;
} {
  const denominator = build.test_cases.length;
  const numerator = build.test_cases.filter((testCase) => testCase.passed).length;
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}
