import { z } from "zod";
import type { EvaluationRequest } from "../../src/evaluation/contracts.ts";
import type { CandidateBundle } from "../shared/bundle.ts";

export const testCaseResultSchema = z
  .object({
    name: z.string().min(1),
    passed: z.boolean(),
    message: z.string().optional(),
  })
  .strict();

export const submissionBuildSchema = z
  .object({
    compiled: z.boolean(),
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

export const buildAttestationSchema = z
  .object({
    backend_id: z.string().min(1),
    artemis_revision: z.string().nullable().default(null),
    build_agent_image: z.string().nullable().default(null),
    build_script_revision: z.string().nullable().default(null),
    toolchain: z.string().nullable().default(null),
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
  build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome>;
  /** Reconcile or cancel durable remote work during recovery. */
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
