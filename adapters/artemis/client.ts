import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generationExecutionSchema,
  generationResponseSchema,
  type GenerationRequest,
  type GenerationResponse,
} from "../../src/contracts.ts";
import { writeJsonAtomic } from "../../src/core/files.ts";
import {
  asStringMap,
  isCompleteCandidate,
  materializeCandidate,
  type CandidateBundle,
} from "./artifacts.ts";
import { artemisParametersSchema, resolveAuthorization, type ArtemisParameters } from "./config.ts";
import { ArtemisHttpClient, sleep } from "./http.ts";

type ApiMode = "research" | "legacy-pilot";

interface AdapterState {
  schema_version: "1";
  attempt_id: string;
  api_mode: ApiMode;
  remote_id: string;
  exercise_id?: number;
}

interface ActiveRun {
  mode: ApiMode;
  remoteId: string;
  exerciseId?: number;
}

interface ResearchStatus {
  runId?: string;
  state?: string;
  outcome?: string;
  capture?: { completeness?: string; reason?: string };
  bundleAvailable?: boolean;
  model?: unknown;
  usage?: unknown;
  cost?: unknown;
  telemetry?: unknown;
  failure?: unknown;
  [key: string]: unknown;
}

interface LegacyEvent {
  type?: string;
  message?: string;
  completionStatus?: string;
  savedRepositoryCommits?: Record<string, string>;
  savedExerciseVersionId?: number;
  [key: string]: unknown;
}

interface LegacyStatus {
  jobId?: string;
  running?: boolean;
  ownedByCaller?: boolean;
  cancellable?: boolean;
  events?: LegacyEvent[];
  [key: string]: unknown;
}

const TERMINAL_RESEARCH_STATES = new Set([
  "SUCCEEDED",
  "FAILED",
  "ABSTAINED",
  "CANCELLED",
  "CANCELED",
  "COMPLETED",
  "TIMED_OUT",
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function failed(
  message: string,
  extensions: Record<string, unknown>,
  captureReason = message,
): GenerationResponse {
  return generationResponseSchema.parse({
    protocol_version: "1",
    status: "failed",
    artifacts: [],
    capture: { completeness: "none", reason: captureReason },
    message,
    extensions,
  });
}

function infrastructureFailure(
  message: string,
  extensions: Record<string, unknown>,
): GenerationResponse {
  return generationResponseSchema.parse({
    protocol_version: "1",
    status: "infra_failed",
    artifacts: [],
    capture: { completeness: "none", reason: message },
    message,
    extensions,
  });
}

async function readState(
  outputDirectory: string,
  attemptId: string,
): Promise<AdapterState | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(outputDirectory, "artemis", "adapter-state.json"), "utf8"),
    ) as Partial<AdapterState>;
    if (
      value.schema_version === "1" &&
      value.attempt_id === attemptId &&
      (value.api_mode === "research" || value.api_mode === "legacy-pilot") &&
      typeof value.remote_id === "string"
    ) {
      return value as AdapterState;
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  throw new Error("adapter state does not match this generation attempt");
}

async function storeState(outputDirectory: string, state: AdapterState): Promise<void> {
  await writeJsonAtomic(join(outputDirectory, "artemis", "adapter-state.json"), state);
}

function effectiveExerciseId(
  request: GenerationRequest,
  parameters: ArtemisParameters,
): number | undefined {
  const targetValue = request.target.parameters.exercise_id;
  return (
    parameters.exercise_id ??
    (typeof targetValue === "number" && Number.isSafeInteger(targetValue) && targetValue > 0
      ? targetValue
      : undefined)
  );
}

function normalizeResearchOutcome(status: ResearchStatus): GenerationResponse["status"] {
  const outcome = stringOf(status.outcome)?.toUpperCase();
  const state = stringOf(status.state)?.toUpperCase();
  if (outcome === "SUCCEEDED" || outcome === "SUCCESS" || state === "SUCCEEDED") {
    return "succeeded";
  }
  if (outcome === "ABSTAINED" || state === "ABSTAINED") {
    return "abstained";
  }
  return "failed";
}

function captureCompleteness(value: unknown): "complete" | "partial" | "none" {
  const normalized = stringOf(value)?.toLowerCase();
  return normalized === "complete" || normalized === "partial" ? normalized : "none";
}

function normalizedUsage(value: Record<string, unknown> | undefined):
  | {
      input_tokens?: number;
      output_tokens?: number;
      reasoning_tokens?: number;
      cached_input_tokens?: number;
      total_tokens?: number;
      model_calls?: number;
      tool_calls?: number;
    }
  | undefined {
  if (!value) {
    return undefined;
  }
  const result: {
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cached_input_tokens?: number;
    total_tokens?: number;
    model_calls?: number;
    tool_calls?: number;
  } = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cached_input_tokens",
    "total_tokens",
    "model_calls",
    "tool_calls",
  ] as const) {
    const amount = numberOf(value[key]);
    if (amount !== undefined) {
      result[key] = amount;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export class ArtemisGenerator {
  private readonly parameters: ArtemisParameters;
  private readonly http: ArtemisHttpClient;
  private active: ActiveRun | undefined;

  constructor(
    private readonly request: GenerationRequest,
    private readonly outputDirectory: string,
  ) {
    this.parameters = artemisParametersSchema.parse(request.parameters);
    this.http = new ArtemisHttpClient(
      this.parameters.base_url,
      resolveAuthorization(this.parameters),
      this.parameters.request_timeout_ms,
      this.parameters.max_http_retries,
      this.parameters.max_http_response_bytes,
    );
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }
    try {
      if (active.mode === "research") {
        await this.http.json(
          `/api/hyperion/generation/runs/${encodeURIComponent(active.remoteId)}/cancel`,
          { method: "POST" },
        );
      } else if (active.exerciseId !== undefined) {
        await this.http.json(
          `/api/hyperion/programming-exercises/${active.exerciseId}/generate-exercise/jobs/${encodeURIComponent(active.remoteId)}`,
          { method: "DELETE" },
        );
      }
    } catch {
      // Cancellation is best-effort; the durable state remains reconcilable on retry.
    }
  }

  async generate(signal: AbortSignal): Promise<GenerationResponse> {
    let mode: ApiMode | undefined;
    try {
      const state = await readState(this.outputDirectory, this.request.attempt.id);
      mode = state?.api_mode ?? (await this.selectMode(signal));
      return mode === "research"
        ? await this.generateResearch(state, signal)
        : await this.generateLegacy(state, signal);
    } catch (error) {
      if (signal.aborted) {
        await this.cancel();
        return failed("Artemis generation was cancelled", {
          artemis: {
            api_mode: mode ?? this.parameters.api_mode,
            remote_id: this.active?.remoteId,
            failure_class: "cancelled",
          },
        });
      }
      return infrastructureFailure(messageOf(error), {
        artemis: {
          api_mode: mode ?? this.parameters.api_mode,
          remote_id: this.active?.remoteId,
          failure_class: "infrastructure",
        },
      });
    }
  }

  private async selectMode(signal: AbortSignal): Promise<ApiMode> {
    if (this.parameters.api_mode === "research") {
      await this.requireResearchCapabilities(signal);
      return "research";
    }
    return "legacy-pilot";
  }

  private async requireResearchCapabilities(signal: AbortSignal): Promise<void> {
    const capabilities = recordOf(
      await this.http.json<unknown>("/api/hyperion/generation/capabilities", { signal }),
    );
    const version =
      stringOf(capabilities?.protocol_version) ??
      stringOf(recordOf(capabilities?.researchApi)?.version);
    if (
      version !== "1" ||
      capabilities?.durable_runs !== true ||
      capabilities.idempotent_start !== true ||
      capabilities.artifact_bundle !== true ||
      capabilities.sequenced_events !== true ||
      capabilities.cancellation !== true
    ) {
      throw new Error(
        "Artemis does not advertise research API v1 with durable runs, idempotent start, sequenced events, cancellation, and artifact bundles",
      );
    }
  }

  private async startResearch(signal: AbortSignal): Promise<string> {
    const body = {
      protocol_version: "1",
      client_attempt_id: this.request.attempt.id,
      input: {
        id: this.request.case.id,
        title: this.request.case.title,
        brief: this.request.case.brief,
        tags: this.request.case.tags,
      },
      target: this.request.target,
      approach: this.parameters.approach,
      model_profile: this.parameters.model_profile,
      scaffold_ref: this.parameters.scaffold_ref,
      seed: this.request.attempt.seed,
      budget: this.request.budget,
      extensions: this.parameters.request_extensions,
    };
    try {
      const started = recordOf(
        await this.http.json<unknown>("/api/hyperion/generation/runs", {
          method: "POST",
          body,
          headers: { "idempotency-key": this.request.attempt.id },
          signal,
          retry: true,
        }),
      );
      const runId = stringOf(started?.runId) ?? stringOf(started?.run_id);
      if (!runId) {
        throw new Error("Artemis research start response did not contain runId");
      }
      return runId;
    } catch (startError) {
      const reconciled = recordOf(
        await this.http
          .json<unknown>(
            `/api/hyperion/generation/runs/by-client-attempt/${encodeURIComponent(this.request.attempt.id)}`,
            { signal },
          )
          .catch(() => undefined),
      );
      const runId = stringOf(reconciled?.runId) ?? stringOf(reconciled?.run_id);
      if (runId) {
        return runId;
      }
      throw startError;
    }
  }

  private async generateResearch(
    state: AdapterState | undefined,
    signal: AbortSignal,
  ): Promise<GenerationResponse> {
    const runId = state?.remote_id ?? (await this.startResearch(signal));
    this.active = { mode: "research", remoteId: runId };
    if (!state) {
      await storeState(this.outputDirectory, {
        schema_version: "1",
        attempt_id: this.request.attempt.id,
        api_mode: "research",
        remote_id: runId,
      });
    }

    const deadline = Date.now() + this.request.budget.wall_time_ms;
    let status: ResearchStatus | undefined;
    let after = 0;
    const events: unknown[] = [];
    for (;;) {
      if (Date.now() >= deadline) {
        await this.cancel();
        throw new Error("Artemis research run exceeded the benchmark wall-time budget");
      }
      status = await this.http.json<ResearchStatus>(
        `/api/hyperion/generation/runs/${encodeURIComponent(runId)}`,
        { signal },
      );
      const page = recordOf(
        await this.http.json<unknown>(
          `/api/hyperion/generation/runs/${encodeURIComponent(runId)}/events?after=${after}`,
          { signal },
        ),
      );
      const newEvents = Array.isArray(page?.events) ? page.events : [];
      for (const event of newEvents) {
        const sequence = numberOf(recordOf(event)?.sequence);
        if (!Number.isSafeInteger(sequence) || sequence === undefined || sequence <= after) {
          throw new Error("Artemis research API returned an unsequenced or non-monotonic event");
        }
        events.push(event);
        after = sequence;
      }
      const stateName = stringOf(status.state)?.toUpperCase();
      if (stateName && TERMINAL_RESEARCH_STATES.has(stateName)) {
        break;
      }
      await sleep(
        Math.min(this.parameters.poll_interval_ms, Math.max(1, deadline - Date.now())),
        signal,
      );
    }
    if (!status) {
      throw new Error("Artemis research run ended without status");
    }

    const rawBundle = recordOf(
      await this.http.json<unknown>(
        `/api/hyperion/generation/runs/${encodeURIComponent(runId)}/bundle`,
        { signal },
      ),
    );
    if (!rawBundle) {
      throw new Error("Artemis research bundle is not a JSON object");
    }
    const candidateRecord = recordOf(rawBundle.candidate) ?? rawBundle;
    const bundle: CandidateBundle = {
      ...(typeof candidateRecord.problem_statement === "string"
        ? { problem_statement: candidateRecord.problem_statement }
        : {}),
      ...(candidateRecord.template !== undefined
        ? { template: asStringMap(candidateRecord.template, "template") }
        : {}),
      ...(candidateRecord.solution !== undefined
        ? { solution: asStringMap(candidateRecord.solution, "solution") }
        : {}),
      ...(candidateRecord.tests !== undefined
        ? { tests: asStringMap(candidateRecord.tests, "tests") }
        : {}),
    };
    const outcome = normalizeResearchOutcome(status);
    let completeness = captureCompleteness(
      recordOf(rawBundle.capture)?.completeness ?? status.capture?.completeness,
    );
    if (completeness === "complete" && !isCompleteCandidate(bundle)) {
      completeness = Object.keys(bundle).length > 0 ? "partial" : "none";
    }
    if (completeness === "none" && Object.keys(bundle).length > 0) {
      completeness = "partial";
    }
    if (outcome === "succeeded" && !isCompleteCandidate(bundle)) {
      throw new Error("Artemis reported success without a complete candidate bundle");
    }
    const artifacts = await materializeCandidate(
      this.outputDirectory,
      bundle,
      this.parameters.max_artifact_bytes,
    );
    await writeJsonAtomic(join(this.outputDirectory, "artemis", "research-evidence.json"), {
      protocol_version: "1",
      run_id: runId,
      status,
      events,
      bundle_metadata: rawBundle.metadata ?? rawBundle.provenance,
      verification: rawBundle.verification,
    });

    const statusModel = recordOf(status.model) ?? recordOf(rawBundle.model);
    const modelProvider = stringOf(statusModel?.provider);
    const modelId = stringOf(statusModel?.id);
    const modelVersion = stringOf(statusModel?.version);
    const statusUsage = normalizedUsage(recordOf(status.usage) ?? recordOf(rawBundle.usage));
    const statusCost = recordOf(status.cost) ?? recordOf(rawBundle.cost);
    const costAmount = numberOf(statusCost?.amount);
    const costCurrency = stringOf(statusCost?.currency);
    const effectiveExecution =
      recordOf(status.effective_execution) ?? recordOf(rawBundle.effective_execution);
    return generationResponseSchema.parse({
      protocol_version: "1",
      status: outcome,
      artifacts,
      capture: {
        completeness: artifacts.length === 0 ? "none" : completeness,
        reason:
          stringOf(recordOf(rawBundle.capture)?.reason) ??
          status.capture?.reason ??
          (artifacts.length === 0 ? "research API returned no candidate artifacts" : undefined),
      },
      message: stringOf(recordOf(status.failure)?.message),
      model:
        modelProvider && modelId
          ? {
              provider: modelProvider,
              id: modelId,
              version: modelVersion,
            }
          : undefined,
      usage: statusUsage,
      execution: effectiveExecution
        ? generationExecutionSchema.parse(effectiveExecution)
        : {
            requested_seed: this.request.attempt.seed,
            seed_status: "unverifiable",
            effective_parameters: {},
            provider_request_ids: [],
            provider_request_ids_complete: false,
          },
      cost:
        costAmount !== undefined && costCurrency?.length === 3
          ? { amount: costAmount, currency: costCurrency }
          : undefined,
      extensions: {
        artemis: {
          api_mode: "research",
          run_id: runId,
          evidence_path: "artemis/research-evidence.json",
          approach: rawBundle.approach,
          provenance: rawBundle.provenance,
          verification: rawBundle.verification,
          telemetry_summary: status.telemetry,
          effective_execution: effectiveExecution,
        },
      },
    });
  }

  private async reconcileLegacy(
    exerciseId: number,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const status = await this.http
      .json<LegacyStatus>(
        `/api/hyperion/programming-exercises/${exerciseId}/generate-exercise/status`,
        { signal },
      )
      .catch(() => undefined);
    return status?.running === true && status.ownedByCaller !== false
      ? stringOf(status.jobId)
      : undefined;
  }

  private async startLegacy(exerciseId: number, signal: AbortSignal): Promise<string> {
    if (this.request.case.brief.length > 8_000) {
      throw new Error(
        "legacy-pilot mode cannot submit briefs longer than the PR API's 8,000-character prompt limit",
      );
    }
    try {
      const started = recordOf(
        await this.http.json<unknown>(
          `/api/hyperion/programming-exercises/${exerciseId}/generate-exercise`,
          {
            method: "POST",
            body: { mode: "GENERATE", prompt: this.request.case.brief },
            signal,
          },
        ),
      );
      const jobId = stringOf(started?.jobId);
      if (!jobId) {
        throw new Error("Artemis legacy start response did not contain jobId");
      }
      return jobId;
    } catch (startError) {
      const reconciled = await this.reconcileLegacy(exerciseId, signal);
      if (reconciled) {
        return reconciled;
      }
      throw startError;
    }
  }

  private async generateLegacy(
    state: AdapterState | undefined,
    signal: AbortSignal,
  ): Promise<GenerationResponse> {
    const exerciseId = state?.exercise_id ?? effectiveExerciseId(this.request, this.parameters);
    if (!exerciseId) {
      throw new Error(
        "legacy-pilot mode requires an isolated exercise_id in adapter or target parameters",
      );
    }
    const jobId = state?.remote_id ?? (await this.startLegacy(exerciseId, signal));
    this.active = { mode: "legacy-pilot", remoteId: jobId, exerciseId };
    if (!state) {
      await storeState(this.outputDirectory, {
        schema_version: "1",
        attempt_id: this.request.attempt.id,
        api_mode: "legacy-pilot",
        remote_id: jobId,
        exercise_id: exerciseId,
      });
    }

    const deadline = Date.now() + this.request.budget.wall_time_ms;
    let status: LegacyStatus | undefined;
    for (;;) {
      if (Date.now() >= deadline) {
        await this.cancel();
        throw new Error("Artemis legacy run exceeded the benchmark wall-time budget");
      }
      status = await this.http.json<LegacyStatus>(
        `/api/hyperion/programming-exercises/${exerciseId}/generate-exercise/status`,
        { signal },
      );
      if (status.jobId !== jobId) {
        throw new Error(
          "legacy-pilot exercise was reused by another job; one isolated exercise per attempt is required",
        );
      }
      if (status.running === false) {
        break;
      }
      await sleep(
        Math.min(this.parameters.poll_interval_ms, Math.max(1, deadline - Date.now())),
        signal,
      );
    }
    if (!status) {
      throw new Error("Artemis legacy run ended without status");
    }
    const events = Array.isArray(status.events) ? status.events : [];
    const terminal = [...events]
      .reverse()
      .find((event) => ["DONE", "ERROR", "CANCELLED"].includes(event.type ?? ""));
    await writeJsonAtomic(join(this.outputDirectory, "artemis", "legacy-transcript.json"), {
      api_mode: "legacy-pilot",
      exercise_id: exerciseId,
      job_id: jobId,
      status,
    });

    if (
      terminal?.type !== "DONE" ||
      !["SUCCESS", "NEEDS_REVIEW"].includes(terminal.completionStatus ?? "") ||
      !terminal.savedExerciseVersionId
    ) {
      return failed(
        terminal?.message ?? "Artemis legacy generation did not save a complete exercise version",
        {
          artemis: {
            api_mode: "legacy-pilot",
            exercise_id: exerciseId,
            job_id: jobId,
            completion_status: terminal?.completionStatus,
            termination_reason: terminal?.terminationReason,
            verdict: terminal?.verdict,
            transcript_path: "artemis/legacy-transcript.json",
            failed_artifact_capture: "unavailable",
          },
        },
        "the legacy/pilot API does not expose failed candidate workspaces",
      );
    }

    const versionId = terminal.savedExerciseVersionId;
    const snapshot = recordOf(
      await this.http.json<unknown>(`/api/exercise/exercises/${exerciseId}/versions/${versionId}`, {
        signal,
      }),
    );
    const programming = recordOf(snapshot?.programmingData);
    const templateParticipation = recordOf(programming?.templateParticipation);
    const solutionParticipation = recordOf(programming?.solutionParticipation);
    const commits = terminal.savedRepositoryCommits ?? {};
    const templateCommit =
      stringOf(templateParticipation?.commitId) ??
      stringOf(commits.TEMPLATE) ??
      stringOf(commits.template);
    const solutionCommit =
      stringOf(solutionParticipation?.commitId) ??
      stringOf(commits.SOLUTION) ??
      stringOf(commits.solution);
    const testsCommit =
      stringOf(programming?.testsCommitId) ?? stringOf(commits.TESTS) ?? stringOf(commits.tests);
    if (
      !snapshot ||
      typeof snapshot.problemStatement !== "string" ||
      !templateCommit ||
      !solutionCommit ||
      !testsCommit
    ) {
      throw new Error("saved Artemis version does not contain all exact artifact commit IDs");
    }
    const repositoryPath = `/api/programming/programming-exercises/${exerciseId}/files-content-commit-details`;
    const readRepository = async (
      repositoryType: "TEMPLATE" | "SOLUTION" | "TESTS",
      commitId: string,
    ): Promise<Record<string, string>> =>
      asStringMap(
        await this.http.json<unknown>(
          `${repositoryPath}?commitId=${encodeURIComponent(commitId)}&repositoryType=${repositoryType}`,
          { signal },
        ),
        repositoryType,
      );
    const [template, solution, tests] = await Promise.all([
      readRepository("TEMPLATE", templateCommit),
      readRepository("SOLUTION", solutionCommit),
      readRepository("TESTS", testsCommit),
    ]);
    const bundle: CandidateBundle = {
      problem_statement: snapshot.problemStatement,
      template,
      solution,
      tests,
    };
    if (!isCompleteCandidate(bundle)) {
      throw new Error("saved Artemis version contains an empty canonical artifact role");
    }
    const artifacts = await materializeCandidate(
      this.outputDirectory,
      bundle,
      this.parameters.max_artifact_bytes,
    );
    await writeJsonAtomic(join(this.outputDirectory, "artemis", "legacy-version.json"), {
      exercise_id: exerciseId,
      version_id: versionId,
      commits: {
        template: templateCommit,
        solution: solutionCommit,
        tests: testsCommit,
      },
      snapshot,
    });
    return generationResponseSchema.parse({
      protocol_version: "1",
      status: "succeeded",
      artifacts,
      capture: { completeness: "complete" },
      message: terminal.message,
      extensions: {
        artemis: {
          api_mode: "legacy-pilot",
          limitations: [
            "live-exercise mutation",
            "exercise-keyed transient replay",
            "no idempotent start",
            "no failed-workspace export",
            "no complete per-run model telemetry",
          ],
          exercise_id: exerciseId,
          job_id: jobId,
          saved_exercise_version_id: versionId,
          saved_repository_commits: {
            template: templateCommit,
            solution: solutionCommit,
            tests: testsCommit,
          },
          completion_status: terminal.completionStatus,
          termination_reason: terminal.terminationReason,
          verdict: terminal.verdict,
          transcript_path: "artemis/legacy-transcript.json",
          version_evidence_path: "artemis/legacy-version.json",
        },
      },
    });
  }
}
