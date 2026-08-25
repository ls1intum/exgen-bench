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
