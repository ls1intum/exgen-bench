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

interface AdapterState {
  schema_version: "2";
  attempt_id: string;
  remote_id: string;
}

interface ActiveRun {
  remoteId: string;
}

interface RunStatus {
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

const TERMINAL_RUN_STATES = new Set([
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

function failed(message: string, extensions: Record<string, unknown>): GenerationResponse {
  return generationResponseSchema.parse({
    protocol_version: "1",
    status: "failed",
    artifacts: [],
    capture: { completeness: "none", reason: message },
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
      value.schema_version === "2" &&
      value.attempt_id === attemptId &&
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

function normalizeOutcome(status: RunStatus): GenerationResponse["status"] {
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
      await this.http.json(
        `/api/hyperion/generation/runs/${encodeURIComponent(active.remoteId)}/cancel`,
        { method: "POST" },
      );
    } catch {
      // Cancellation is best-effort; the durable state remains reconcilable on retry.
    }
  }

  async generate(signal: AbortSignal): Promise<GenerationResponse> {
    try {
      const state = await readState(this.outputDirectory, this.request.attempt.id);
      if (!state) {
        await this.requireCapabilities(signal);
      }
      return await this.generateRun(state, signal);
    } catch (error) {
      if (signal.aborted) {
        await this.cancel();
        return failed("Artemis generation was cancelled", {
          artemis: {
            remote_id: this.active?.remoteId,
            failure_class: "cancelled",
          },
        });
      }
      return infrastructureFailure(messageOf(error), {
        artemis: {
          remote_id: this.active?.remoteId,
          failure_class: "infrastructure",
        },
      });
    }
  }

  private async requireCapabilities(signal: AbortSignal): Promise<void> {
    const capabilities = recordOf(
      await this.http.json<unknown>("/api/hyperion/generation/capabilities", { signal }),
    );
    const version = stringOf(capabilities?.protocol_version);
    if (
      version !== "1" ||
      capabilities?.durable_runs !== true ||
      capabilities.idempotent_start !== true ||
      capabilities.artifact_bundle !== true ||
      capabilities.sequenced_events !== true ||
      capabilities.cancellation !== true
    ) {
      throw new Error(
        "Artemis does not advertise benchmark API v1 with durable runs, idempotent start, sequenced events, cancellation, and artifact bundles",
      );
    }
  }

  private async startRun(signal: AbortSignal): Promise<string> {
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
        throw new Error("Artemis generation start response did not contain runId");
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

  private async generateRun(
    state: AdapterState | undefined,
    signal: AbortSignal,
  ): Promise<GenerationResponse> {
    const runId = state?.remote_id ?? (await this.startRun(signal));
    this.active = { remoteId: runId };
    if (!state) {
      await storeState(this.outputDirectory, {
        schema_version: "2",
        attempt_id: this.request.attempt.id,
        remote_id: runId,
      });
    }

    const deadline = Date.now() + this.request.budget.wall_time_ms;
    let status: RunStatus | undefined;
    let after = 0;
    const events: unknown[] = [];
    for (;;) {
      if (Date.now() >= deadline) {
        await this.cancel();
        throw new Error("Artemis generation run exceeded the benchmark wall-time budget");
      }
      status = await this.http.json<RunStatus>(
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
          throw new Error("Artemis benchmark API returned an unsequenced or non-monotonic event");
        }
        events.push(event);
        after = sequence;
      }
      const stateName = stringOf(status.state)?.toUpperCase();
      if (stateName && TERMINAL_RUN_STATES.has(stateName)) {
        break;
      }
      await sleep(
        Math.min(this.parameters.poll_interval_ms, Math.max(1, deadline - Date.now())),
        signal,
      );
    }
    if (!status) {
      throw new Error("Artemis generation run ended without status");
    }

    const rawBundle = recordOf(
      await this.http.json<unknown>(
        `/api/hyperion/generation/runs/${encodeURIComponent(runId)}/bundle`,
        { signal },
      ),
    );
    if (!rawBundle) {
      throw new Error("Artemis generation bundle is not a JSON object");
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
    const outcome = normalizeOutcome(status);
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
    await writeJsonAtomic(join(this.outputDirectory, "artemis", "generation-evidence.json"), {
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
          (artifacts.length === 0 ? "benchmark API returned no candidate artifacts" : undefined),
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
          run_id: runId,
          evidence_path: "artemis/generation-evidence.json",
          approach: rawBundle.approach,
          provenance: rawBundle.provenance,
          verification: rawBundle.verification,
          telemetry_summary: status.telemetry,
          effective_execution: effectiveExecution,
        },
      },
    });
  }
}
