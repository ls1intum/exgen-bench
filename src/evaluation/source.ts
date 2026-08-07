import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { validateAndDigestArtifacts } from "../adapters/artifacts.ts";
import { factorSchema, generationResponseSchema } from "../contracts.ts";
import { digestJson, sha256 } from "../core/canonical.ts";
import { buildEvidenceManifest } from "../core/evidence.ts";
import type { AttemptRow } from "../core/ledger.ts";
import { Ledger } from "../core/ledger.ts";
import { referenceCostSchema } from "../pricing/openrouter.ts";
import {
  type EvaluationCandidate,
  type EvaluationRequest,
  type EvaluationResponse,
  type EvaluationSuite,
  type EvaluatorIdentity,
  evaluationResponseSchema,
} from "./contracts.ts";
import { referenceCostFields } from "./reference-cost.ts";
import {
  readEvaluationJournalHistory,
  readEvaluationJournal as readValidatedEvaluationJournal,
} from "./runner.ts";
import type { GenerationObservation } from "./summary.ts";

const storedObservationSchema = z
  .object({
    schema_version: z.literal("1"),
    observation_id: z.string().min(1),
    plan_attempt_id: z.string().min(1),
    generation_key: z.string().regex(/^[a-f0-9]{64}$/),
    lifecycle: z.enum(["completed", "failed", "cancelled", "interrupted"]),
    outcome: z.string().optional(),
    duration_ms: z.number().nonnegative().nullable(),
    budget: z
      .object({
        status: z.enum(["compliant", "exceeded", "unverifiable", "non_binding"]),
        violations: z.array(z.string()),
        missing: z.array(z.string()),
      })
      .strict(),
    response: generationResponseSchema.optional(),
    reference_cost: referenceCostSchema.optional(),
    artifact_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .passthrough();

type StoredObservation = z.infer<typeof storedObservationSchema>;

async function readStoredObservation(
  runDirectory: string,
  attemptId: string,
): Promise<StoredObservation | null> {
  try {
    return storedObservationSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "attempts", attemptId, "observation.json"), "utf8"),
      ),
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `invalid generation observation for ${attemptId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function verifyRunEvidence(runDirectory: string, rows: AttemptRow[]): Promise<void> {
  for (const row of rows) {
    if (!["completed", "failed", "cancelled", "interrupted"].includes(row.state)) {
      continue;
    }
    if (!row.evidenceDigest) {
      throw new Error(`terminal attempt ${row.id} has no evidence digest`);
    }
    const attemptDirectory = join(runDirectory, "attempts", row.id);
    const recordedManifest = JSON.parse(
      await readFile(join(attemptDirectory, "evidence-manifest.json"), "utf8"),
    ) as { digest?: unknown };
    const effectiveEvidenceDigest = digestJson(await buildEvidenceManifest(attemptDirectory));
    if (
      recordedManifest.digest !== row.evidenceDigest ||
      effectiveEvidenceDigest !== row.evidenceDigest
    ) {
      throw new Error(`evidence digest mismatch for terminal attempt ${row.id}`);
    }
    const observation = await readStoredObservation(runDirectory, row.id);
    if (!observation) {
      throw new Error(`terminal attempt ${row.id} has no observation`);
    }
    if (
      observation.plan_attempt_id !== row.id ||
      observation.generation_key !== row.generationKey ||
      observation.lifecycle !== row.state ||
      (observation.outcome ?? null) !== row.outcome ||
      (observation.artifact_digest ?? null) !== row.artifactDigest
    ) {
      throw new Error(`observation does not reconcile with ledger attempt ${row.id}`);
    }
    if (row.artifactDigest) {
      if (!observation.response) {
        throw new Error(`completed attempt ${row.id} has no generation response`);
      }
      const digest = await validateAndDigestArtifacts(
        observation.response,
        join(attemptDirectory, "output"),
      );
      if (digest !== row.artifactDigest) {
        throw new Error(`artifact digest mismatch for completed attempt ${row.id}`);
      }
    }
  }
}

/**
 * A stored run is evidence already written, so these schemas validate only the fields evaluation
 * reads: rejecting a manifest over a field nobody consumes would make old evidence unreachable.
 * `attestation` is optional here and required by `systemSchema`, which still gates planning.
 */
const storedSystemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    revision: z.string().min(1),
    factors: z.record(z.string(), factorSchema).default({}),
    attestation: z
      .object({ deployment_deviations: z.array(z.unknown()) })
      .passthrough()
      .optional(),
  })
  .passthrough();

const storedTargetSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    revision: z.string().min(1),
  })
  .passthrough();

const storedAnalysisSchema = z
  .object({
    method: z.enum(["case_clustered_bootstrap", "case_clustered_paired_bootstrap"]),
    estimand: z.enum([
      "end_to_end_within_budget_strict_success_rate",
      "end_to_end_within_budget_strict_success_rate_difference",
    ]),
    bootstrap_seed: z.number().int(),
    bootstrap_resamples: z.number().int(),
    confidence_level: z.number().gt(0).lt(1),
    contrasts: z
      .array(z.object({ system_a: z.string(), system_b: z.string() }).passthrough())
      .default([]),
    registration: z
      .object({
        uri: z.string(),
        registered_at: z.string(),
        revision: z.string(),
        amendment_uri: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const storedRunManifestSchema = z
  .object({
    run_id: z.string().min(1),
    run_instance_id: z.string().min(1),
    plan: z
      .object({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        benchmark: z.object({ id: z.string(), title: z.string() }),
        dataset: z.object({
          id: z.string(),
          version: z.string(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
        target: storedTargetSchema,
        analysis: storedAnalysisSchema,
        systems: z.array(storedSystemSchema),
        cases: z.array(
          z
            .object({
              id: z.string(),
              title: z.string(),
              tags: z.array(z.string()),
              brief: z.string(),
              digest: z.string(),
              origin: z.object({
                kind: z.enum(["synthetic", "adapted", "collected"]),
                source_uri: z.string().optional(),
                citation: z.string().optional(),
                created_at: z.string(),
                first_public_at: z.string().optional(),
              }),
              authors: z.array(z.object({ name: z.string(), orcid: z.string().optional() })),
              license: z.string(),
              exposure: z.object({
                generator_visible: z.literal(true),
                known_public: z.boolean(),
                notes: z.string(),
              }),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

export type StoredSystem = z.infer<typeof storedSystemSchema>;
export type StoredTarget = z.infer<typeof storedTargetSchema>;

export interface RunEvaluationSource {
  runDirectory: string;
  runId: string;
  experimentId: string;
  runManifest: z.infer<typeof storedRunManifestSchema>;
  planId: string;
  benchmark: { id: string; title: string };
  dataset: { id: string; version: string; digest: string };
  target: StoredTarget;
  systems: StoredSystem[];
  attestation: { unattested_systems: string[] };
  cases: Array<{
    id: string;
    title: string;
    tags: string[];
    brief: string;
    digest: string;
    origin: {
      kind: "synthetic" | "adapted" | "collected";
      source_uri?: string | undefined;
      citation?: string | undefined;
      created_at: string;
      first_public_at?: string | undefined;
    };
    authors: Array<{ name: string; orcid?: string | undefined }>;
    license: string;
    exposure: { generator_visible: true; known_public: boolean; notes: string };
  }>;
  generations: GenerationObservation[];
  candidates: EvaluationCandidate[];
}

/**
 * `release create` refuses an unattested system, so every command that reads a run warns before
 * that refusal rather than after it.
 */
export function warnIfUnattested(source: Pick<RunEvaluationSource, "runId" | "attestation">): void {
  if (source.attestation.unattested_systems.length === 0) {
    return;
  }
  process.stderr.write(
    `warning: run ${source.runId} has no deployment attestation for ${source.attestation.unattested_systems.join(", ")}; it can be evaluated, but 'release create' will refuse it until attestation.deployment_deviations is added to its manifest\n`,
  );
}

export async function loadRunEvaluationSource(
  runDirectoryInput: string,
  options?: { verifyEvidence?: boolean },
): Promise<RunEvaluationSource> {
  const runDirectory = resolve(runDirectoryInput);
  const manifest = storedRunManifestSchema.parse(
    JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")),
  );
  const ledger = Ledger.open(runDirectory);
  try {
    const rows = ledger.list();
    if (options?.verifyEvidence !== false) {
      await verifyRunEvidence(runDirectory, rows);
    }
    const generations: GenerationObservation[] = await Promise.all(
      rows.map(async (row) => {
        const observation = await readStoredObservation(runDirectory, row.id);
        const usage = observation?.response?.usage;
        const cost = observation?.response?.cost;
        return {
          attempt_id: row.id,
          case_id: row.caseId,
          system_id: row.systemId,
          replicate: row.replicate,
          seed: row.seed,
          state: row.state,
          outcome: row.outcome,
          error_code: row.errorCode,
          started_at: row.startedAt,
          finished_at: row.finishedAt,
          experiment_id: manifest.run_instance_id,
          generation_key: row.generationKey,
          artifact_digest: row.artifactDigest,
          evidence_digest: row.evidenceDigest,
          capture_completeness: observation?.response?.capture.completeness ?? null,
          budget_status: observation?.budget.status ?? null,
          budget_violations: observation?.budget.violations ?? [],
          budget_missing: observation?.budget.missing ?? [],
          generation_duration_ms: observation?.duration_ms ?? null,
          model_calls: usage?.model_calls ?? null,
          tool_calls: usage?.tool_calls ?? null,
          input_tokens: usage?.input_tokens ?? null,
          output_tokens: usage?.output_tokens ?? null,
          cached_input_tokens: usage?.cached_input_tokens ?? null,
          reasoning_tokens: usage?.reasoning_tokens ?? null,
          total_tokens: usage?.total_tokens ?? null,
          cost_amount: cost?.amount ?? null,
          cost_currency: cost?.currency ?? null,
          ...referenceCostFields(observation?.reference_cost),
          seed_status: observation?.response?.execution?.seed_status ?? null,
          effective_parameters_digest: observation?.response?.execution
            ? digestJson(observation.response.execution.effective_parameters)
            : null,
          provider_request_ids_digest: observation?.response?.execution
            ? digestJson(observation.response.execution.provider_request_ids)
            : null,
          provider_request_ids_complete:
            observation?.response?.execution?.provider_request_ids_complete ?? null,
        };
      }),
    );
    const completenessByAttempt = new Map(
      generations.map((observation) => [observation.attempt_id, observation.capture_completeness]),
    );
    const candidates = rows
      .filter(
        (row): row is typeof row & { artifactDigest: string } =>
          row.state === "completed" && row.artifactDigest !== null,
      )
      .map((row) => ({
        experiment_id: manifest.run_instance_id,
        attempt_id: row.id,
        generation_key: row.generationKey,
        case_id: row.caseId,
        system_id: row.systemId,
        replicate: row.replicate,
        artifact_digest: row.artifactDigest,
        capture_completeness: (completenessByAttempt.get(row.id) === "partial"
          ? "partial"
          : "complete") as "complete" | "partial",
        bundle_path: join(runDirectory, "attempts", row.id, "output"),
      }));
    const unattestedSystems = manifest.plan.systems
      .filter((system) => system.attestation === undefined)
      .map((system) => system.id)
      .sort();
    return {
      runDirectory,
      runId: manifest.run_id,
      experimentId: manifest.run_instance_id,
      runManifest: manifest,
      planId: manifest.plan.id,
      benchmark: manifest.plan.benchmark,
      dataset: manifest.plan.dataset,
      target: manifest.plan.target,
      systems: manifest.plan.systems,
      attestation: { unattested_systems: unattestedSystems },
      cases: manifest.plan.cases,
      generations,
      candidates,
    };
  } finally {
    ledger.close();
  }
}

export async function loadEvaluationJournal(path: string): Promise<EvaluationResponse[]> {
  const latest = await readValidatedEvaluationJournal(path);
  return [...latest.values()].sort((left, right) =>
    left.evaluation_id < right.evaluation_id
      ? -1
      : left.evaluation_id > right.evaluation_id
        ? 1
        : 0,
  );
}

export async function loadEvaluationJournalForRelease(path: string): Promise<{
  latest: EvaluationResponse[];
  history: EvaluationResponse[];
}> {
  const history = await readEvaluationJournalHistory(path);
  const latestById = new Map<string, EvaluationResponse>();
  for (const response of history) {
    latestById.set(response.evaluation_id, response);
  }
  const latest = [...latestById.values()].sort((left, right) =>
    left.evaluation_id < right.evaluation_id
      ? -1
      : left.evaluation_id > right.evaluation_id
        ? 1
        : 0,
  );
  return { latest, history };
}

export async function builtInBundleEvaluatorIdentity(
  target: StoredTarget,
): Promise<EvaluatorIdentity> {
  const implementation = new Uint8Array(
    await Bun.file(new URL("./source.ts", import.meta.url)).arrayBuffer(),
  );
  return {
    id: "bundle-integrity",
    version: "1",
    revision: "source-v1",
    target_profile: target.id,
    implementation_digest: sha256(implementation),
    configuration_digest: digestJson({
      evaluator: "bundle-integrity",
      target,
    }),
  };
}

export function builtInDevelopmentSuite(target: StoredTarget): EvaluationSuite {
  return {
    id: "development-smoke",
    version: "1",
    digest: digestJson({
      purpose: "development-only bundle integrity; not an independent study evaluator",
      target,
    }),
  };
}

export async function executeBundleIntegrityEvaluation(
  request: EvaluationRequest,
): Promise<EvaluationResponse> {
  const startedAt = new Date().toISOString();
  const monotonic = performance.now();
  const responsePath = join(request.candidate.bundle_path, "response.json");
  try {
    const generationResponse = generationResponseSchema.parse(
      JSON.parse(await readFile(responsePath, "utf8")),
    );
    const effectiveDigest = await validateAndDigestArtifacts(
      generationResponse,
      request.candidate.bundle_path,
    );
    const accepted = effectiveDigest === request.candidate.artifact_digest;
    const finishedAt = new Date().toISOString();
    return evaluationResponseSchema.parse({
      protocol_version: "1",
      evaluation_id: request.evaluation_id,
      candidate: {
        experiment_id: request.candidate.experiment_id,
        attempt_id: request.candidate.attempt_id,
        generation_key: request.candidate.generation_key,
        case_id: request.candidate.case_id,
        system_id: request.candidate.system_id,
        replicate: request.candidate.replicate,
        artifact_digest: request.candidate.artifact_digest,
        capture_completeness: request.candidate.capture_completeness,
      },
      evaluator: request.evaluator,
      suite: request.suite,
      status: accepted ? "succeeded" : "quality_failed",
      strict_success: accepted,
      ...(accepted ? {} : { failure_category: "candidate.invalid" }),
      scores: [
        {
          metric_id: "bundle.integrity",
          metric_version: "1",
          status: accepted ? "ok" : "quality_failure",
          value: accepted,
          evidence: ["response.json"],
        },
      ],
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.round(Math.max(0, performance.now() - monotonic)),
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    return evaluationResponseSchema.parse({
      protocol_version: "1",
      evaluation_id: request.evaluation_id,
      candidate: {
        experiment_id: request.candidate.experiment_id,
        attempt_id: request.candidate.attempt_id,
        generation_key: request.candidate.generation_key,
        case_id: request.candidate.case_id,
        system_id: request.candidate.system_id,
        replicate: request.candidate.replicate,
        artifact_digest: request.candidate.artifact_digest,
        capture_completeness: request.candidate.capture_completeness,
      },
      evaluator: request.evaluator,
      suite: request.suite,
      status: "quality_failed",
      strict_success: false,
      failure_category: "candidate.invalid",
      scores: [
        {
          metric_id: "bundle.integrity",
          metric_version: "1",
          status: "quality_failure",
          value: false,
          message: error instanceof Error ? error.message : String(error),
          evidence: [],
        },
      ],
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.round(Math.max(0, performance.now() - monotonic)),
    });
  }
}
