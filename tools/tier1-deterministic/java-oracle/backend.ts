import { z } from "zod";

import type { EvaluationRequest } from "../../../src/evaluation/contracts.ts";
import type { CandidateBundle } from "../../kit/bundle.ts";

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
    analysis: z
      .object({
        lines: z
          .array(
            z.object({
              path: z.string(),
              line: z.number().int().positive(),
              covered: z.boolean(),
              branchesCovered: z.number().int().nonnegative(),
              branchesMissed: z.number().int().nonnegative(),
            }),
          )
          .nullable(),
        compiler: z
          .array(
            z.object({
              path: z.string(),
              line: z.number().int().positive(),
              kind: z.enum(["raw_type", "unchecked"]),
            }),
          )
          .nullable(),
        suppressions: z.number().int().nonnegative(),
      })
      .optional(),
    diagnostics: z.array(z.string()).max(64).default([]),
  })
  .strict();

/**
 * What the deployment could attest about how the build ran.
 *
 * Every field is nullable, and a null recorded alongside an `unattested` list is not the same as an
 * omitted field: it stops a reader assuming two runs months apart were built the same way.
 *
 * What is attestable is narrower than what matters, and the split is deliberate. Artemis returns the
 * exercise's `buildConfig`, so the agent image, the phase scripts and the branch are read from the
 * deployment's own answer. It reports no revision of itself, so `artemis_revision` stays null and
 * named in `unattested` rather than being inferred from something adjacent. Nothing here may be
 * filled in from a default, a guess or a constant: an attestation that cannot be traced to a field
 * the deployment returned is worse than an admitted gap.
 */
export const buildAttestationSchema = z
  .object({
    backend_id: z.string().min(1),
    artemis_revision: z.string().nullable().default(null),
    /** The build agent image Artemis reported, digest-pinned only as far as the deployment pins it. */
    build_agent_image: z.string().nullable().default(null),
    /**
     * `sha256:<hex>` over the exact build-plan configuration Artemis returned.
     *
     * Artemis exposes the build script itself but no revision of it, so this identifies the script
     * by its content. It is not an upstream VCS revision and must not be read as one; two runs whose
     * scripts differ get different values, which is the property attestation actually needs.
     */
    build_script_revision: z.string().nullable().default(null),
    toolchain: z.string().nullable().default(null),
    /** The build phases Artemis reported, verbatim, so a reader can audit the script content. */
    build_phase_scripts: z
      .array(z.object({ name: z.string().min(1), script: z.string() }).strict())
      .default([]),
    build_branch: z.string().nullable().default(null),
    unattested: z.array(z.string()).default([]),
  })
  .strict();

export const mutantSchema = z
  .object({
    class: z.string(),
    method: z.string(),
    line: z.number().int().nonnegative(),
    mutator: z.string(),
    /** PIT's status, verbatim: KILLED, SURVIVED, NO_COVERAGE, TIMED_OUT, NON_VIABLE, ... */
    status: z.string().min(1),
  })
  .strict();

/**
 * Mutation analysis of the solution, by a backend that can run it. `not_applicable` is a property
 * of the candidate or the backend (no changed class, Ares 1); `failed` is a run that should have
 * produced a report and did not, which is never read as a score.
 */
export const mutationRunSchema = z
  .object({
    status: z.enum(["measured", "not_applicable", "failed"]),
    reason: z.string().min(1).optional(),
    tool: z.string().nullable().default(null),
    target_classes: z.array(z.string()).default([]),
    mutants: z.array(mutantSchema).max(20_000).default([]),
  })
  .strict();

/**
 * The output-only bypass probe (see `bypass.ts`): the graded tests run against the solution with the
 * body of one `main` replaced by a print of that `main`'s own output.
 */
export const bypassRunSchema = z
  .object({
    status: z.enum(["measured", "not_applicable", "failed"]),
    reason: z.string().min(1).optional(),
    main_class: z.string().nullable().default(null),
    transcript_characters: z.number().int().nonnegative().default(0),
    test_cases: z.array(testCaseResultSchema).default([]),
    /** Results with the same entry point printing nothing; absent in old recordings. */
    silent_test_cases: z.array(testCaseResultSchema).optional(),
  })
  .strict();

export const buildOutcomeSchema = z
  .object({
    template: submissionBuildSchema,
    solution: submissionBuildSchema,
    attestation: buildAttestationSchema,
    /** Absent when the backend does not run mutation analysis at all. */
    mutation: mutationRunSchema.optional(),
    /** Absent when the backend does not run the bypass probe at all. */
    bypass: bypassRunSchema.optional(),
  })
  .strict();

export type TestCaseResult = z.infer<typeof testCaseResultSchema>;
export type SubmissionBuild = z.infer<typeof submissionBuildSchema>;
export type BuildAttestation = z.infer<typeof buildAttestationSchema>;
export type BuildOutcome = z.infer<typeof buildOutcomeSchema>;
export type Mutant = z.infer<typeof mutantSchema>;
export type MutationRun = z.infer<typeof mutationRunSchema>;
export type BypassRun = z.infer<typeof bypassRunSchema>;

export interface BuildJob {
  request: EvaluationRequest;
  bundle: CandidateBundle;
  /** Skip additional source audits for mutation and constraint builds. */
  analysis?: boolean;
}

export interface BuildBackend {
  readonly id: string;
  build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome>;
  /** Reconcile or cancel durable remote work during recovery. */
  recover?(job: BuildJob, signal: AbortSignal): Promise<void>;
}

/** Whether a build ran tests and every one of them passed, the precondition of every extra pass. */
export function passesEveryTest(build: SubmissionBuild): boolean {
  return (
    build.compiled &&
    build.tests_executed &&
    build.test_cases.length > 0 &&
    build.test_cases.every((testCase) => testCase.passed)
  );
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
