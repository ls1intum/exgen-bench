import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type GenerationRequest,
  type GenerationResponse,
  generationExecutionSchema,
  generationResponseSchema,
} from "../../src/contracts.ts";
import { writeJsonAtomic } from "../../src/core/files.ts";
import { type CandidateBundle, isCompleteCandidate, materializeCandidate } from "./artifacts.ts";
import { type ArtemisParameters, artemisParametersSchema, resolveAuthorization } from "./config.ts";
import { EventJournal, type EventJournalSummary } from "./events.ts";
import { ArtemisHttpClient, ArtemisHttpError, sleep } from "./http.ts";
import {
  eventPageSchema,
  type GenerationRun,
  generationBundleSchema,
  generationCapabilitiesSchema,
  generationRunResult,
  generationRunSchema,
  runReferenceSchema,
} from "./protocol.ts";

interface AdapterState {
  schema_version: "2";
  attempt_id: string;
  remote_id: string;
}

interface ActiveRun {
  remoteId: string;
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

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assertGenerationIdentity(
  status: GenerationRun,
  runId: string,
  request: GenerationRequest,
  parameters: ArtemisParameters,
): void {
  if (status.runId !== runId) {
    throw new Error("Artemis generation status echoed a different runId");
  }
  if (status.client_attempt_id !== request.attempt.id) {
    throw new Error("Artemis generation status echoed a different client_attempt_id");
  }
  if (
    status.approach.id !== parameters.approach.id ||
    status.approach.version !== parameters.approach.version
  ) {
    throw new Error("Artemis generation status echoed a different approach identity");
  }
  if (status.effective_execution.requested_seed !== request.attempt.seed) {
    throw new Error("Artemis generation status echoed a different requested seed");
  }
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
      this.parameters.max_http_total_bytes,
    );
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }
    await this.http.json(
      `/api/hyperion/generation/runs/${encodeURIComponent(active.remoteId)}/cancel`,
      { method: "POST", retry: true },
    );
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

  async recover(signal: AbortSignal): Promise<void> {
    const state = await readState(this.outputDirectory, this.request.attempt.id);
    let runId = state?.remote_id;
    if (!runId) {
      try {
        runId = runReferenceSchema.parse(
          await this.http.json<unknown>(
            `/api/hyperion/generation/runs/by-client-attempt/${encodeURIComponent(this.request.attempt.id)}`,
            { signal },
          ),
        ).runId;
      } catch (error) {
        if (error instanceof ArtemisHttpError && error.status === 404) {
          return;
        }
        throw error;
      }
    }

    this.active = { remoteId: runId };
    let cancellationRequested = false;
    for (;;) {
      const status = generationRunSchema.parse(
        await this.http.json<unknown>(
          `/api/hyperion/generation/runs/${encodeURIComponent(runId)}`,
          { signal },
        ),
      );
      assertGenerationIdentity(status, runId, this.request, this.parameters);
      if (TERMINAL_RUN_STATES.has(status.state)) {
        return;
      }
      if (!cancellationRequested) {
        await this.http.json(`/api/hyperion/generation/runs/${encodeURIComponent(runId)}/cancel`, {
          method: "POST",
          signal,
          retry: true,
        });
        cancellationRequested = true;
      }
      await sleep(this.parameters.poll_interval_ms, signal);
    }
  }

  private async requireCapabilities(signal: AbortSignal): Promise<void> {
    const capabilities = generationCapabilitiesSchema.safeParse(
      await this.http.json<unknown>("/api/hyperion/generation/capabilities", { signal }),
    );
    if (!capabilities.success) {
      throw new Error(
        "Artemis does not advertise benchmark API v1 with durable runs, idempotent start, sequenced events, cancellation, and artifact bundles",
        { cause: capabilities.error },
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
      const started = runReferenceSchema.parse(
        await this.http.json<unknown>("/api/hyperion/generation/runs", {
          method: "POST",
          body,
          headers: { "idempotency-key": this.request.attempt.id },
          signal,
          retry: true,
        }),
      );
      return started.runId;
    } catch (startError) {
      try {
        const reconciled = runReferenceSchema.parse(
          await this.http.json<unknown>(
            `/api/hyperion/generation/runs/by-client-attempt/${encodeURIComponent(this.request.attempt.id)}`,
            { signal },
          ),
        );
        return reconciled.runId;
      } catch (reconcileError) {
        if (reconcileError instanceof ArtemisHttpError && reconcileError.status === 404) {
          throw startError;
        }
        throw reconcileError;
      }
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
    let status: GenerationRun | undefined;
    let after = 0;
    const eventJournal = await EventJournal.create(
      this.outputDirectory,
      "artemis/events.jsonl",
      this.parameters.max_event_count,
      this.parameters.max_event_bytes,
    );
    let eventJournalSummary: EventJournalSummary;
    try {
      for (;;) {
        if (Date.now() >= deadline) {
          await this.cancel();
          throw new Error("Artemis generation run exceeded the benchmark wall-time budget");
        }
        status = generationRunSchema.parse(
          await this.http.json<unknown>(
            `/api/hyperion/generation/runs/${encodeURIComponent(runId)}`,
            { signal },
          ),
        );
        assertGenerationIdentity(status, runId, this.request, this.parameters);
        const terminal = TERMINAL_RUN_STATES.has(status.state);
        for (;;) {
          const page = eventPageSchema.parse(
            await this.http.json<unknown>(
              `/api/hyperion/generation/runs/${encodeURIComponent(runId)}/events?after=${after}`,
              { signal },
            ),
          );
          for (const event of page.events) {
            if (event.sequence <= after) {
              throw new Error(
                "Artemis benchmark API returned an unsequenced or non-monotonic event",
              );
            }
            await eventJournal.append(event);
            after = event.sequence;
          }
          if (!terminal || page.events.length === 0) {
            break;
          }
        }
        if (terminal) {
          break;
        }
        await sleep(
          Math.min(this.parameters.poll_interval_ms, Math.max(1, deadline - Date.now())),
          signal,
        );
      }
      eventJournalSummary = await eventJournal.finalize();
    } catch (error) {
      await eventJournal.discard();
      throw error;
    }
    if (!status) {
      throw new Error("Artemis generation run ended without status");
    }

    const rawBundle = generationBundleSchema.parse(
      await this.http.json<unknown>(
        `/api/hyperion/generation/runs/${encodeURIComponent(runId)}/bundle`,
        { signal },
      ),
    );
    const candidateRecord = rawBundle.candidate ?? {};
    const bundle: CandidateBundle = {
      ...(candidateRecord.problem_statement !== undefined
        ? { problem_statement: candidateRecord.problem_statement }
        : {}),
      ...(candidateRecord.template !== undefined ? { template: candidateRecord.template } : {}),
      ...(candidateRecord.solution !== undefined ? { solution: candidateRecord.solution } : {}),
      ...(candidateRecord.tests !== undefined ? { tests: candidateRecord.tests } : {}),
    };
    const outcome = generationRunResult(status);
    const completeness = rawBundle.capture.completeness;
    if (completeness === "complete" && !isCompleteCandidate(bundle)) {
      throw new Error("Artemis reported complete capture without a complete candidate bundle");
    }
    if (completeness === "none" && Object.keys(bundle).length > 0) {
      throw new Error("Artemis reported no capture but returned candidate artifacts");
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
      event_journal: eventJournalSummary,
      bundle_metadata: rawBundle.metadata,
      candidate_metadata: rawBundle.candidate?.metadata,
      verification: rawBundle.verification,
    });

    return generationResponseSchema.parse({
      protocol_version: "1",
      status: outcome,
      artifacts,
      capture: {
        completeness,
        reason:
          rawBundle.capture.reason ??
          (artifacts.length === 0 ? "benchmark API returned no candidate artifacts" : undefined),
      },
      message: stringOf(status.failure?.message),
      model: status.model,
      usage: status.usage,
      execution: generationExecutionSchema.parse(status.effective_execution),
      cost: status.cost,
      extensions: {
        artemis: {
          run_id: runId,
          evidence_path: "artemis/generation-evidence.json",
          approach: status.approach,
          provenance: status.provenance,
          verification: rawBundle.verification,
          telemetry_summary: status.telemetry,
          effective_execution: status.effective_execution,
        },
      },
    });
  }
}
