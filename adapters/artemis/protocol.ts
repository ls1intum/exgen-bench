import { z } from "zod";
import { generationExecutionSchema } from "../../src/contracts.ts";
import { evaluationSuiteSchema, evaluatorIdentitySchema } from "../../src/evaluation/contracts.ts";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const generationStateSchema = z.enum([
  "ADMITTED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "ABSTAINED",
  "CANCELLED",
  "CANCELED",
  "TIMED_OUT",
  "COMPLETED",
]);
const generationOutcomeSchema = z.enum(["SUCCEEDED", "SUCCESS", "FAILED", "ABSTAINED"]);
const verificationStateSchema = z.enum([
  "ADMITTED",
  "RUNNING",
  "PASSED",
  "FAILED",
  "ERROR",
  "COMPLETED",
]);
const verificationOutcomeSchema = z.enum(["PASSED", "SUCCESS", "FAILED", "REJECTED", "ERROR"]);

const captureSchema = z
  .object({
    completeness: z.enum(["complete", "partial", "none"]),
    reason: z.string().min(1).optional(),
  })
  .strict();

const modelSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    version: z.string().min(1).optional(),
  })
  .passthrough();

const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    cached_input_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    model_calls: z.number().int().nonnegative().optional(),
    tool_calls: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const costSchema = z
  .object({
    amount: z.number().nonnegative(),
    currency: z.string().length(3),
  })
  .strict();

const approachSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    implementation_digest: sha256DigestSchema,
    factors: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const textTreeSchema = z.record(z.string(), z.string()).superRefine((tree, context) => {
  for (const path of Object.keys(tree)) {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      /^[A-Za-z]:\//.test(path) ||
      path.includes("\0") ||
      path.includes("\\") ||
      path
        .split("/")
        .some((component) => component === "" || component === "." || component === "..")
    ) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: "artifact paths must be safe relative paths without dot segments",
      });
    }
  }
});

const executionEnvironmentSchema = z
  .object({
    image_digest: sha256DigestSchema,
    toolchain_digest: digestSchema,
  })
  .strict();

const generationProvenanceSchema = z
  .object({
    artemis_revision: z.string().min(1),
    prompt_digest: digestSchema,
    environment: executionEnvironmentSchema,
  })
  .passthrough();

export const verificationProvenanceSchema = z
  .object({
    artemis_revision: z.string().min(1),
    verifier_revision: z.string().min(1),
    environment: executionEnvironmentSchema,
  })
  .passthrough();

const candidateSchema = z
  .object({
    problem_statement: z.string().optional(),
    template: textTreeSchema.optional(),
    solution: textTreeSchema.optional(),
    tests: textTreeSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function generationResult(
  state: z.infer<typeof generationStateSchema>,
  outcome?: string,
): "succeeded" | "failed" | "abstained" | undefined {
  if (state === "SUCCEEDED" || outcome === "SUCCEEDED" || outcome === "SUCCESS") {
    return "succeeded";
  }
  if (state === "FAILED" || outcome === "FAILED") {
    return "failed";
  }
  if (state === "ABSTAINED" || outcome === "ABSTAINED") {
    return "abstained";
  }
  if (state === "CANCELLED" || state === "CANCELED" || state === "TIMED_OUT") {
    return "failed";
  }
  return undefined;
}

function verificationResult(value?: string): "passed" | "failed" | "error" | undefined {
  if (value === "PASSED" || value === "SUCCESS") {
    return "passed";
  }
  if (value === "FAILED" || value === "REJECTED") {
    return "failed";
  }
  if (value === "ERROR") {
    return "error";
  }
  return undefined;
}

export const runReferenceSchema = z
  .object({
    runId: z.string().min(1),
  })
  .strict();

export const generationCapabilitiesSchema = z
  .object({
    protocol_version: z.literal("1"),
    durable_runs: z.literal(true),
    idempotent_start: z.literal(true),
    artifact_bundle: z.literal(true),
    sequenced_events: z.literal(true),
    cancellation: z.literal(true),
    artemis_revision: z.string().optional(),
    registered_approaches: z.array(approachSchema).optional(),
  })
  .passthrough();

export const verificationCapabilitiesSchema = z
  .object({
    protocol_version: z.literal("1"),
    durable_runs: z.literal(true),
    canonical_candidate_verifier: z.literal(true),
    idempotent_start: z.literal(true),
    sequenced_events: z.literal(true),
    cancellation: z.literal(true),
    verifier_profiles: z.array(z.string()).optional(),
  })
  .passthrough();

const eventSchema = z
  .object({
    sequence: z.number().int().positive(),
    occurred_at: z.string().datetime({ offset: true }),
    type: z.string().min(1),
    publishability: z.enum(["public", "restricted"]).optional(),
  })
  .passthrough();

export const eventPageSchema = z
  .object({
    events: z.array(eventSchema),
  })
  .strict();

export const generationRunSchema = z
  .object({
    runId: z.string().min(1),
    client_attempt_id: z.string().min(1),
    state: generationStateSchema,
    outcome: generationOutcomeSchema.optional(),
    bundleAvailable: z.boolean().optional(),
    approach: approachSchema,
    usage: usageSchema.optional(),
    model: modelSchema.optional(),
    cost: costSchema.optional(),
    telemetry: z.record(z.string(), z.unknown()).optional(),
    failure: z.record(z.string(), z.unknown()).optional(),
    provenance: generationProvenanceSchema,
    effective_execution: generationExecutionSchema,
  })
  .passthrough()
  .superRefine((run, context) => {
    const stateResult = generationResult(run.state);
    const outcomeResult = generationResult(
      run.state === "COMPLETED" ? "COMPLETED" : "RUNNING",
      run.outcome,
    );
    if (run.state === "COMPLETED" && outcomeResult === undefined) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "a completed generation run requires an outcome",
      });
    } else if (
      run.state !== "COMPLETED" &&
      run.outcome !== undefined &&
      stateResult !== outcomeResult
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "generation state and outcome contradict each other",
      });
    }
  });

export type GenerationRun = z.infer<typeof generationRunSchema>;

export function generationRunResult(run: GenerationRun): "succeeded" | "failed" | "abstained" {
  const result = generationResult(run.state, run.outcome);
  if (result === undefined) {
    throw new Error("generation run is not terminal");
  }
  return result;
}

export const generationBundleSchema = z
  .object({
    capture: captureSchema,
    candidate: candidateSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    verification: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const verificationRunSchema = z
  .object({
    runId: z.string().min(1),
    client_attempt_id: z.string().min(1),
    state: verificationStateSchema,
    outcome: verificationOutcomeSchema.optional(),
    result: verificationOutcomeSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const outcome = verificationResult(run.outcome);
    const result = verificationResult(run.result);
    if (outcome !== undefined && result !== undefined && outcome !== result) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "verification outcome and result contradict each other",
      });
    }
    const terminalResult = outcome ?? result;
    if (run.state === "COMPLETED") {
      if (terminalResult === undefined) {
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "a completed verification run requires an outcome or result",
        });
      }
      return;
    }
    const stateResult = verificationResult(run.state);
    if (terminalResult !== undefined && stateResult !== terminalResult) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "verification state and outcome contradict each other",
      });
    }
  });

export type VerificationRun = z.infer<typeof verificationRunSchema>;

export function verificationRunResult(run: VerificationRun): "passed" | "failed" | "error" {
  const result =
    run.state === "COMPLETED"
      ? (verificationResult(run.outcome) ?? verificationResult(run.result))
      : verificationResult(run.state);
  if (result === undefined) {
    throw new Error("verification run is not terminal");
  }
  return result;
}

export const verificationEvidenceSchema = z
  .object({
    runId: z.string().min(1),
    client_attempt_id: z.string().min(1),
    candidate_digest: digestSchema,
    evaluator: evaluatorIdentitySchema,
    suite: evaluationSuiteSchema,
    report: z.record(z.string(), z.unknown()),
    provenance: verificationProvenanceSchema,
  })
  .strict();
