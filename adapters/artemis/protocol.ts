import { z } from "zod";

export const exerciseSchema = z.looseObject({
  id: z.number().int().positive(),
  title: z.string().optional(),
  shortName: z.string().optional(),
  packageName: z.string().optional(),
  problemStatement: z.string().nullish(),
  programmingLanguage: z.string().optional(),
  projectType: z.string().optional(),
});

const generationModeSchema = z.enum(["GENERATE", "ADAPT"]);

const verdictSchema = z.looseObject({ mechanicallyVerified: z.boolean().optional() });

export const generationEventSchema = z.looseObject({
  type: z.enum(["STARTED", "PROGRESS", "DONE", "CANCELLED", "ERROR"]),
  message: z.string().optional(),
  completionStatus: z.enum(["SUCCESS", "NEEDS_REVIEW", "PARTIAL"]).optional(),
  verdict: verdictSchema.optional(),
  liveExerciseChanged: z.boolean().optional(),
  savedRepositoryCommits: z.record(z.string(), z.string()).optional(),
  savedExerciseVersionId: z.number().int().positive().optional(),
  terminationReason: z.string().optional(),
  repairRound: z.unknown().optional(),
  timestamp: z.iso.datetime({ offset: true }),
});

export const generationStatusSchema = z
  .looseObject({
    jobId: z.string().min(1),
    running: z.boolean(),
    mode: generationModeSchema.optional(),
    events: z.array(generationEventSchema).default([]),
    fileChanges: z.array(z.unknown()).default([]),
    ownedByCaller: z.boolean().optional(),
    cancellable: z.boolean().optional(),
    revertAvailable: z.boolean().optional(),
    revertJobId: z.string().min(1).nullish(),
    revertMode: generationModeSchema.nullish(),
    specDocument: z.string().optional(),
    // Additive upstream fields must not invalidate terminal accounting.
    usage: z
      .looseObject({
        modelCalls: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        agentTurns: z.number().int().nonnegative().optional(),
        attempts: z.number().int().nonnegative().optional(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        cachedInputTokensComplete: z.boolean(),
        estimatedCostEur: z.number().nonnegative(),
        estimatedCostEurComplete: z.boolean(),
        models: z.array(z.string().min(1)),
        providerRequestIds: z.array(z.string().min(1)),
        providerRequestIdsComplete: z.boolean(),
      })
      .optional(),
    // An absent seal cannot safely mean either pending or permanently incomplete.
    accountingState: z.enum(["PENDING", "COMPLETE", "INCOMPLETE"]),
    effortProfile: z.string().min(1).optional(),
    // Status-reported limits outrank operator declarations as evidence.
    limits: z
      .strictObject({
        max_job_duration_ms: z.number().int().positive().optional(),
        max_tokens_per_job: z.number().int().positive().optional(),
        max_turns: z.number().int().positive().optional(),
        context_window_tokens: z.number().int().positive().optional(),
        admission_max_tokens_per_user: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .superRefine((status, context) => {
    if (status.accountingState === "COMPLETE" && status.usage === undefined) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "usage is required when accountingState is COMPLETE",
      });
    }
    if (
      status.usage?.providerRequestIdsComplete &&
      status.usage.providerRequestIds.length !== status.usage.modelCalls
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage", "providerRequestIds"],
        message: "complete provider request IDs require one identifier per model call",
      });
    }
  });

export const jobStartSchema = z.strictObject({ jobId: z.string().min(1) });

/**
 * The candidate a terminal run produced but never saved. `completeness` is stated by Artemis rather
 * than inferred here: the retention is bounded and screened, and whether a file was dropped is not
 * discoverable from the file list.
 */
export const retainedArtifactsSchema = z.looseObject({
  jobId: z.string().min(1),
  completeness: z.enum(["COMPLETE", "PARTIAL"]),
  problemStatement: z.string().optional(),
  specDocument: z.string().optional(),
  files: z
    .array(
      z.looseObject({
        repo: z.enum(["template", "solution", "tests"]),
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .default([]),
});

export const effortProfilesSchema = z.array(
  z.looseObject({ name: z.string().min(1), label: z.string().min(1).optional() }),
);

export const exerciseVersionSchema = z.looseObject({
  id: z.number().int().positive(),
  title: z.string(),
  shortName: z.string(),
  problemStatement: z.string().min(1),
  programmingData: z.looseObject({
    packageName: z.string().min(1).optional(),
    templateParticipation: z.looseObject({ commitId: z.string().min(1) }),
    solutionParticipation: z.looseObject({ commitId: z.string().min(1) }),
    testsCommitId: z.string().min(1),
  }),
});

export type GenerationStatus = z.infer<typeof generationStatusSchema>;
export type GenerationEvent = z.infer<typeof generationEventSchema>;
