import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GENERATION_PROTOCOL_VERSION,
  type GenerationRequest,
  type GenerationResponse,
  generationResponseSchema,
} from "../../src/contracts.ts";
import { writeJsonAtomic } from "../../src/core/files.ts";
import { reconcileOpenRouterUsage } from "../openrouter/reconciliation.ts";
import { materializeCandidate, verifyExportedRepositoryCommits } from "./artifacts.ts";
import {
  type ArtemisCredentials,
  type ArtemisParameters,
  artemisParametersSchema,
  resolveCredentials,
  withoutUsageVerification,
} from "./config.ts";
import { EventJournal, type EventJournalSummary } from "./events.ts";
import { ArtemisHttpClient, ArtemisHttpError, jwtCookie, sleep } from "./http.ts";
import { type AdapterState, parseAdapterState, statePath } from "./state.ts";
import {
  type GenerationEvent,
  type GenerationStatus,
  exerciseSchema,
  exerciseVersionSchema,
  generationStatusSchema,
  jobStartSchema,
} from "./protocol.ts";
import {
  type ArtemisTargetParameters,
  requiresPackageName,
  resolveTargetFormat,
} from "./target.ts";
import {
  captureTelemetry,
  telemetryCursor,
  type TelemetryCapture,
  type TelemetryUsage,
} from "./opentelemetry.ts";

interface CompleteAccounting {
  usage: NonNullable<GenerationResponse["usage"]> & {
    model_calls: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cost?: GenerationResponse["cost"];
  models: string[];
  providerRequestIds: string[];
  providerRequestIdsComplete: boolean;
}

type Diagnostic = NonNullable<GenerationResponse["diagnostics"]>[number];

// GenerationJobReplayStore keeps at most this many events and drops from index 1 once it overflows.
const SERVER_EVENT_RETENTION = 500;
// Artemis rejects Java/Kotlin package segments that are language keywords.
const PACKAGE_SEGMENT_PREFIX = "exgen";

const ACCOUNTING_GAP =
  "Artemis did not mark token accounting complete within accounting_settle_ms, so the telemetry cross-check could not run";

/**
 * How the measurement planes (provider cost reconciliation and OpenTelemetry) resolved for an
 * attempt whose Hyperion outcome is already determined. Two of these are measurement gaps and two
 * are failures to verify, and the difference decides whether the outcome may be overwritten.
 *
 * - `captured`: every configured plane agreed.
 * - `trace_unavailable`: the trace could not be obtained at all. Missingness, so it never
 *   overwrites a generation outcome Hyperion already determined.
 * - `cost_unverifiable`: the provider's billing records could not be reached. Also missingness; no
 *   unverified amount is published in their place.
 * - `product_accounting_incomplete`: Artemis did not account for its own usage, so the check that
 *   exists to catch under-reporting has nothing to check against. Fails closed, because otherwise a
 *   system that under-reports its usage would switch that check off.
 * - `disagreed`: the trace is capturable but contradicts Artemis's own accounting. The measurement
 *   apparatus is self-contradictory, so the attempt fails closed whatever Hyperion decided.
 */
type MeasurementOutcome =
  | "captured"
  | "trace_unavailable"
  | "cost_unverifiable"
  | "product_accounting_incomplete"
  | "disagreed";

const FAILS_CLOSED: readonly MeasurementOutcome[] = ["disagreed", "product_accounting_incomplete"];

interface Measurement {
  outcome: MeasurementOutcome;
  reason?: string | undefined;
  accounting?: CompleteAccounting | undefined;
  costVerified: boolean;
  costReconciliationConfigured: boolean;
  telemetry?: TelemetryCapture | undefined;
  diagnostics: Diagnostic[];
}

type LimitSource = "system_reported" | "system_configured" | "unknown";

interface EffectiveLimit {
  id: string;
  source: LimitSource;
  value?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mismatches(rows: Array<[string, unknown, unknown]>): string[] {
  return rows
    .filter(([, expected, observed]) => expected !== observed)
    .map(
      ([field, expected, observed]) =>
        `${field}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
    );
}

function eventDiagnostic(summary?: EventJournalSummary) {
  return summary
    ? [
        {
          id: "artemis-events",
          kind: "event_journal" as const,
          path: summary.path,
          media_type: "application/x-ndjson",
          sha256: summary.sha256,
          size_bytes: summary.bytes,
          record_count: summary.count,
          visibility: "restricted" as const,
        },
      ]
    : [];
}

async function jsonDiagnostic(outputDirectory: string, path: string, id: string) {
  const bytes = new Uint8Array(await Bun.file(join(outputDirectory, path)).arrayBuffer());
  return {
    id,
    kind: "provenance" as const,
    path,
    media_type: "application/json",
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.byteLength,
    visibility: "restricted" as const,
  };
}

interface FailureResponse {
  status: "failed" | "infra_failed";
  message: string;
  completeness?: "none" | "partial";
  state: AdapterState | undefined;
  journal: EventJournalSummary | undefined;
  accounting: CompleteAccounting | undefined;
  requestedSeed: number | undefined;
  diagnostics?: GenerationResponse["diagnostics"];
  artemis?: Record<string, unknown>;
}

function response(failure: FailureResponse): GenerationResponse {
  const { status, message, state, accounting } = failure;
  return generationResponseSchema.parse({
    protocol_version: GENERATION_PROTOCOL_VERSION,
    status,
    artifacts: [],
    diagnostics: failure.diagnostics ?? eventDiagnostic(failure.journal),
    capture: { completeness: failure.completeness ?? "none", reason: message },
    message,
    ...(accounting
      ? { usage: accounting.usage, ...(accounting.cost ? { cost: accounting.cost } : {}) }
      : {}),
    ...(failure.requestedSeed === undefined
      ? {}
      : {
          execution: {
            requested_seed: failure.requestedSeed,
            seed_status: "unsupported" as const,
            effective_parameters: {},
            provider_request_ids: accounting?.providerRequestIds ?? [],
            provider_request_ids_complete: accounting?.providerRequestIdsComplete ?? false,
          },
        }),
    extensions: {
      artemis: {
        failure_class: status === "infra_failed" ? "infrastructure" : "generation",
        ...(state?.exercise_id ? { exercise_id: state.exercise_id } : {}),
        ...(state?.job_id ? { job_id: state.job_id } : {}),
        usage_accounting_complete: Boolean(accounting),
        models: accounting?.models ?? [],
        ...failure.artemis,
      },
    },
  });
}

async function readState(
  output: string,
  request: GenerationRequest,
  parameters: ArtemisParameters,
): Promise<AdapterState | undefined> {
  try {
    // Parsed, not cast: this is the input least likely to be well-formed, and everything below
    // acts on it remotely.
    const value = parseAdapterState(await readFile(statePath(output), "utf8"));
    // schema_version is not checked here: the schema's literal already rejects anything else, with
    // a message that names the field.
    const drift = mismatches([
      ["attempt_id", request.attempt.id, value.attempt_id],
      ["course_id", parameters.course_id, value.course_id],
    ]);
    if (drift.length > 0) {
      throw new Error(
        `Artemis adapter state does not belong to this attempt and course (${drift.join("; ")})`,
      );
    }
    return value;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

async function storeState(output: string, state: AdapterState): Promise<void> {
  await writeJsonAtomic(statePath(output), state);
}

function digestFragment(value: string, length: number): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Derived from the attempt identifier rather than the case title, so the package name is not an
 * uncontrolled per-case difference in an input the agent reads out of its build context.
 */
function draftIdentity(
  request: GenerationRequest,
  parameters: ArtemisParameters,
  format: ArtemisTargetParameters,
): { shortName: string; packageName?: string } {
  const shortName = `${parameters.exercise.short_name_prefix}${digestFragment(request.attempt.id, 12)}`;
  if (!requiresPackageName(format)) return { shortName };
  const segment = `${PACKAGE_SEGMENT_PREFIX}${digestFragment(request.attempt.id, 16)}`;
  const prefix = format.package_prefix;
  return { shortName, packageName: prefix ? `${prefix}.${segment}` : segment };
}

function terminalEvent(status: GenerationStatus): GenerationEvent | undefined {
  return status.events.findLast((event) => ["DONE", "ERROR", "CANCELLED"].includes(event.type));
}

function alignEvents(seen: string[], observed: string[]): { appended: number; dropped: number } {
  const pinned = seen[0] !== undefined && seen[0] === observed[0] ? 1 : 0;
  const seenTail = seen.slice(pinned);
  const observedTail = observed.slice(pinned);
  for (let overlap = Math.min(seenTail.length, observedTail.length); overlap > 0; overlap -= 1) {
    const start = seenTail.length - overlap;
    if (seenTail.every((value, index) => index < start || value === observedTail[index - start])) {
      return { appended: observedTail.length - overlap, dropped: start };
    }
  }
  if (seenTail.length > 0 && observed.length < SERVER_EVENT_RETENTION) {
    throw new Error("Artemis rewrote a previously observed generation event");
  }
  return { appended: observedTail.length, dropped: seenTail.length };
}

function expectedCommits(
  event: GenerationEvent,
): Record<"template" | "solution" | "tests", string> {
  const commits = event.savedRepositoryCommits;
  const result = {
    template: commits?.template,
    solution: commits?.solution,
    tests: commits?.tests,
  };
  if (!result.template || !result.solution || !result.tests) {
    throw new Error(
      "terminal generation event does not identify all three saved repository commits",
    );
  }
  return result as Record<"template" | "solution" | "tests", string>;
}

function completeUsage(status: GenerationStatus): CompleteAccounting | undefined {
  if (status.accountingComplete !== true) return undefined;
  if (!status.usage) {
    throw new Error("Artemis marked usage accounting complete without complete usage fields");
  }
  const {
    modelCalls,
    toolCalls,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cachedInputTokensComplete,
    estimatedCostEur,
    estimatedCostEurComplete,
    models,
    providerRequestIds,
    providerRequestIdsComplete,
  } = status.usage;
  return {
    usage: {
      model_calls: modelCalls,
      tool_calls: toolCalls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cachedInputTokensComplete ? { cached_input_tokens: cachedInputTokens } : {}),
      total_tokens: inputTokens + outputTokens,
    },
    ...(estimatedCostEurComplete
      ? { cost: { amount: estimatedCostEur, currency: "EUR" as const } }
      : {}),
    models,
    providerRequestIds,
    providerRequestIdsComplete,
  };
}

function expectedUsageFrom(accounting: CompleteAccounting): TelemetryUsage {
  const usage = accounting.usage;
  return {
    modelCalls: usage.model_calls,
    toolCalls: usage.tool_calls,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cached_input_tokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cached_input_tokens }),
    ...(usage.reasoning_tokens === undefined
      ? {}
      : { reasoningOutputTokens: usage.reasoning_tokens }),
    ...(accounting.providerRequestIdsComplete
      ? { providerRequestIds: accounting.providerRequestIds }
      : {}),
  };
}

function telemetryExtension(telemetry: TelemetryCapture) {
  return {
    provider: "opentelemetry",
    trace_id: telemetry.traceId,
    span_count: telemetry.spanCount,
    model_span_count: telemetry.modelSpanCount,
  };
}

export class ArtemisGenerator {
  private readonly parameters: ArtemisParameters;
  private readonly format: ArtemisTargetParameters;
  private readonly credentials: ArtemisCredentials;
  private readonly http: ArtemisHttpClient;
  private state: AdapterState | undefined;
  private lastJournal: EventJournalSummary | undefined;
  private droppedEvents = 0;

  constructor(
    private readonly request: GenerationRequest,
    private readonly outputDirectory: string,
  ) {
    this.parameters = artemisParametersSchema.parse(request.parameters);
    this.format = resolveTargetFormat(request.target.id, request.target.parameters);
    if (this.parameters.accounting_settle_ms >= request.budget.wall_time_ms) {
      throw new Error(
        `accounting_settle_ms (${this.parameters.accounting_settle_ms}) must leave wall-time budget (${request.budget.wall_time_ms}) for the generation it settles`,
      );
    }
    this.credentials = resolveCredentials(this.parameters);
    this.http = new ArtemisHttpClient(
      this.parameters.base_url,
      this.credentials.type === "bearer" ? `Bearer ${this.credentials.token}` : undefined,
      this.parameters.request_timeout_ms,
      this.parameters.max_http_retries,
      this.parameters.max_http_response_bytes,
      this.parameters.max_http_total_bytes,
      this.parameters.max_retry_delay_ms,
    );
  }

  private async authenticate(signal: AbortSignal): Promise<void> {
    if (this.credentials.type !== "password") return;
    const authentication = await this.http.jsonResponse<unknown>("/api/core/public/authenticate", {
      method: "POST",
      body: {
        username: this.credentials.username,
        password: this.credentials.password,
        rememberMe: false,
      },
      signal,
    });
    const cookie = jwtCookie(authentication.headers);
    if (!cookie) throw new Error("Artemis authentication did not return its jwt cookie");
    this.http.setCookie(`jwt=${cookie}`);
  }

  async generate(signal: AbortSignal): Promise<GenerationResponse> {
    try {
      await this.authenticate(signal);
      this.state = await readState(this.outputDirectory, this.request, this.parameters);
      if (!this.state) this.state = await this.createIntent();
      this.http.setDeadline(Date.parse(this.state.deadline_at));
      this.state = await this.ensureExercise(this.state, signal);
      this.state = await this.ensureGenerationStarted(this.state, signal);
      return await this.waitAndCollect(this.state, signal);
    } catch (error) {
      await this.cancel(this.phaseSignal(signal, this.parameters.post_cancel_budget_ms)).catch(
        () => undefined,
      );
      const settleMs = this.accountingSettleMs();
      const reconciliation = await this.knownTerminalReconciliation(
        this.phaseSignal(signal, settleMs + this.parameters.request_timeout_ms),
        settleMs,
      );
      let telemetry: TelemetryCapture | undefined;
      let telemetryError: unknown;
      try {
        telemetry = await this.captureKnownTelemetry(
          reconciliation.accounting,
          this.phaseSignal(signal, this.telemetryBudgetMs()),
        );
      } catch (captureError) {
        telemetryError = captureError;
      }
      const cancelled = signal.aborted;
      return response({
        status: cancelled ? "failed" : "infra_failed",
        message: cancelled ? "Artemis generation was cancelled" : messageOf(error),
        state: this.state,
        journal: this.lastJournal,
        accounting: reconciliation.accounting,
        requestedSeed: this.request.attempt.seed,
        diagnostics: [
          ...eventDiagnostic(this.lastJournal),
          ...(reconciliation.diagnostic ? [reconciliation.diagnostic] : []),
          ...(telemetry ? [telemetry.diagnostic] : []),
        ],
        artemis: {
          ...this.eventTruncationExtension(),
          cost_reconciliation_configured: Boolean(this.parameters.cost_reconciliation),
          cost_verified: reconciliation.costVerified,
          effective_limits: this.effectiveLimits(undefined),
          // Structured, not appended to the prose message, so a consumer can filter on it.
          measurement: {
            outcome: telemetryError
              ? "trace_unavailable"
              : reconciliation.accounting
                ? telemetry
                  ? "captured"
                  : "trace_unavailable"
                : "product_accounting_incomplete",
            ...(telemetryError
              ? { reason: `OpenTelemetry capture unavailable: ${messageOf(telemetryError)}` }
              : reconciliation.accounting
                ? {}
                : { reason: ACCOUNTING_GAP }),
          },
          ...(telemetry ? { telemetry: telemetryExtension(telemetry) } : {}),
        },
      });
    }
  }

  private eventTruncationExtension(): Record<string, unknown> {
    return this.droppedEvents > 0 ? { dropped_event_count: this.droppedEvents } : {};
  }

  private phaseSignal(signal: AbortSignal, ms: number): AbortSignal {
    const budget = AbortSignal.timeout(Math.max(1, ms));
    return signal.aborted ? budget : AbortSignal.any([signal, budget]);
  }

  private telemetryBudgetMs(): number {
    const telemetry = this.parameters.telemetry;
    return telemetry ? telemetry.timeout_ms * 2 : this.parameters.request_timeout_ms;
  }

  /**
   * One settle window for both the happy and the error path, so the same accounting evidence is not
   * held to two standards depending on how the attempt ended. Clamped to what is left of the
   * wall-time budget: a settle window that outlives the budget gets the process killed and a
   * finished generation recorded as a timeout. `post_cancel_budget_ms` bounds the cancel request
   * only, and stands in when no deadline has been stamped yet.
   */
  private accountingSettleMs(): number {
    const configured = this.parameters.accounting_settle_ms;
    const deadline = this.state ? Date.parse(this.state.deadline_at) : Number.NaN;
    if (Number.isNaN(deadline)) return Math.min(configured, this.parameters.post_cancel_budget_ms);
    return Math.max(0, Math.min(configured, deadline - Date.now()));
  }

  private async knownTerminalReconciliation(
    signal: AbortSignal,
    settleMs = 0,
  ): Promise<{ accounting?: CompleteAccounting; diagnostic?: Diagnostic; costVerified: boolean }> {
    if (!this.state?.exercise_id || !this.state.job_id) return { costVerified: false };
    const deadline = Date.now() + settleMs;
    try {
      for (;;) {
        const status = await this.status(this.state.exercise_id, signal);
        if (!status || status.jobId !== this.state.job_id) return { costVerified: false };
        const accounting = completeUsage(status);
        if (accounting) {
          if (!this.parameters.cost_reconciliation) return { accounting, costVerified: false };
          try {
            return { ...(await this.reconcileAccounting(accounting, signal)), costVerified: true };
          } catch {
            const { cost: _unverified, ...withoutCost } = accounting;
            return { accounting: withoutCost, costVerified: false };
          }
        }
        if (Date.now() >= deadline) return { costVerified: false };
        await sleep(
          Math.min(this.parameters.poll_interval_ms, Math.max(1, deadline - Date.now())),
          signal,
        );
      }
    } catch {
      return { costVerified: false };
    }
  }

  /**
   * Runs the measurement planes after the candidate evidence is durable. Never throws: a broken
   * measurement must be reportable, not destructive. The caller decides what the outcome means for
   * the attempt status, because only it knows what Hyperion already determined.
   */
  private async measure(
    finalStatus: GenerationStatus,
    state: AdapterState,
    signal: AbortSignal,
  ): Promise<Measurement> {
    const diagnostics: Diagnostic[] = [];
    const base = completeUsage(finalStatus);
    const costReconciliationConfigured = Boolean(this.parameters.cost_reconciliation);
    let accounting = base;
    let costVerified = false;
    let reason: string | undefined;
    let outcome: MeasurementOutcome = "captured";

    if (base && costReconciliationConfigured) {
      try {
        const reconciled = await this.reconcileAccounting(base, signal);
        accounting = reconciled.accounting;
        costVerified = true;
        if (reconciled.diagnostic) diagnostics.push(reconciled.diagnostic);
      } catch (error) {
        // Fail closed on cost: keep Artemis's token counts, publish no unverified amount.
        outcome = "cost_unverifiable";
        reason = `provider cost reconciliation unavailable: ${messageOf(error)}`;
        const { cost: _unverified, ...withoutCost } = base;
        accounting = withoutCost;
      }
    }
    const settled = { costVerified, costReconciliationConfigured, diagnostics };

    if (!this.parameters.telemetry)
      return { outcome, ...(reason ? { reason } : {}), accounting, ...settled };

    if (!accounting) {
      // Artemis could not account for its own usage. Retrying the capture with verification
      // switched off would let a system that under-reports its usage disable the check that exists
      // to catch under-reporting, so the trace is kept as evidence and the attempt fails closed.
      const telemetry = await this.captureUnverified(state, signal, diagnostics);
      return {
        outcome: "product_accounting_incomplete",
        reason: reason ? `${reason}; ${ACCOUNTING_GAP}` : ACCOUNTING_GAP,
        ...settled,
        ...(telemetry ? { telemetry } : {}),
      };
    }

    try {
      const telemetry = await captureTelemetry(
        this.parameters,
        state.telemetry_cursor_bytes,
        state.job_id ?? "",
        expectedUsageFrom(accounting),
        this.outputDirectory,
        signal,
      );
      if (telemetry) diagnostics.push(telemetry.diagnostic);
      return {
        outcome,
        ...(reason ? { reason } : {}),
        accounting,
        ...settled,
        ...(telemetry ? { telemetry } : {}),
      };
    } catch (error) {
      // Distinguish a usage disagreement from an unusable trace without matching error text: retry
      // with verification off. If the trace then captures cleanly, only the cross-check disagreed.
      const captureError = messageOf(error);
      const unverified = await this.captureUnverified(state, signal, diagnostics);
      return {
        outcome: unverified ? "disagreed" : "trace_unavailable",
        reason: unverified
          ? `OpenTelemetry contradicts Artemis accounting: ${captureError}`
          : `OpenTelemetry capture unavailable: ${captureError}`,
        accounting,
        ...settled,
        ...(unverified ? { telemetry: unverified } : {}),
      };
    }
  }

  private async captureUnverified(
    state: AdapterState,
    signal: AbortSignal,
    diagnostics: Diagnostic[],
  ): Promise<TelemetryCapture | undefined> {
    try {
      const telemetry = await captureTelemetry(
        withoutUsageVerification(this.parameters),
        state.telemetry_cursor_bytes,
        state.job_id ?? "",
        undefined,
        this.outputDirectory,
        signal,
      );
      if (telemetry) diagnostics.push(telemetry.diagnostic);
      return telemetry;
    } catch {
      return undefined;
    }
  }

  private async captureKnownTelemetry(
    accounting: CompleteAccounting | undefined,
    signal: AbortSignal,
  ): Promise<TelemetryCapture | undefined> {
    if (!this.state?.job_id) return undefined;
    return await captureTelemetry(
      accounting ? this.parameters : withoutUsageVerification(this.parameters),
      this.state.telemetry_cursor_bytes,
      this.state.job_id,
      accounting ? expectedUsageFrom(accounting) : undefined,
      this.outputDirectory,
      signal,
    );
  }

  private async reconcileAccounting(
    accounting: CompleteAccounting,
    signal: AbortSignal,
  ): Promise<{ accounting: CompleteAccounting; diagnostic?: Diagnostic }> {
    const configuration = this.parameters.cost_reconciliation;
    if (!configuration) return { accounting };
    if (!accounting.providerRequestIdsComplete) {
      throw new Error("provider cost reconciliation requires complete provider request IDs");
    }
    const apiKey = process.env[configuration.api_key_env];
    if (!apiKey) {
      throw new Error(
        `missing provider cost credential environment variable ${configuration.api_key_env}`,
      );
    }
    const reconciliation = await reconcileOpenRouterUsage(
      {
        modelCalls: accounting.usage.model_calls,
        inputTokens: accounting.usage.input_tokens,
        outputTokens: accounting.usage.output_tokens,
        ...(accounting.usage.cached_input_tokens === undefined
          ? {}
          : { cachedInputTokens: accounting.usage.cached_input_tokens }),
        providerRequestIds: accounting.providerRequestIds,
      },
      {
        apiKey,
        baseUrl: configuration.base_url,
        currency: configuration.currency,
        maximumResponseBytes: configuration.max_response_bytes,
        requestTimeoutMs: this.parameters.request_timeout_ms,
        maximumLookups: configuration.max_lookups,
        lookupBudgetMs: configuration.lookup_budget_ms,
        indexingTimeoutMs: configuration.indexing_timeout_ms,
      },
      signal,
    );
    const path = "provider/openrouter-reconciliation.json";
    await writeJsonAtomic(join(this.outputDirectory, path), reconciliation.evidence);
    return {
      accounting: {
        ...accounting,
        usage: {
          ...accounting.usage,
          ...(reconciliation.reasoningTokens === undefined
            ? {}
            : { reasoning_tokens: reconciliation.reasoningTokens }),
        },
        cost: reconciliation.cost,
      },
      diagnostic: await jsonDiagnostic(
        this.outputDirectory,
        path,
        "openrouter-cost-reconciliation",
      ),
    };
  }

  async recover(signal: AbortSignal): Promise<void> {
    await this.authenticate(signal);
    this.state = await readState(this.outputDirectory, this.request, this.parameters);
    if (!this.state) return;
    if (!this.state.exercise_id) {
      const exercise = await this.findExercise(this.state.short_name, signal);
      if (!exercise) return;
      this.state = { ...this.state, phase: "exercise_created", exercise_id: exercise.id };
      await storeState(this.outputDirectory, this.state);
    }
    const exerciseId = this.state.exercise_id;
    if (!exerciseId) return;
    const status = await this.status(exerciseId, signal);
    if (!status || terminalEvent(status)) return;
    if (!this.state.job_id && !ownedGeneration(status)) return;
    const jobId = this.state.job_id ?? status.jobId;
    this.state = { ...this.state, phase: "generation_started", job_id: jobId };
    await storeState(this.outputDirectory, this.state);
    await this.cancel(signal);
    for (;;) {
      const latest = await this.status(exerciseId, signal);
      if (!latest || terminalEvent(latest) || !latest.running) return;
      await sleep(this.parameters.poll_interval_ms, signal);
    }
  }

  async cancel(signal?: AbortSignal): Promise<void> {
    if (!this.state?.exercise_id || !this.state.job_id) return;
    try {
      await this.http.json(
        `/api/hyperion/programming-exercises/${this.state.exercise_id}/generate-exercise/jobs/${encodeURIComponent(this.state.job_id)}`,
        { method: "DELETE", ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      if (!(error instanceof ArtemisHttpError && error.status === 404)) throw error;
    }
  }

  private async createIntent(): Promise<AdapterState> {
    const identity = draftIdentity(this.request, this.parameters, this.format);
    const telemetryCursorBytes = await telemetryCursor(this.parameters);
    const state: AdapterState = {
      schema_version: "3",
      attempt_id: this.request.attempt.id,
      course_id: this.parameters.course_id,
      short_name: identity.shortName,
      phase: "create_intent",
      deadline_at: new Date(Date.now() + this.request.budget.wall_time_ms).toISOString(),
      ...(telemetryCursorBytes === undefined
        ? {}
        : { telemetry_cursor_bytes: telemetryCursorBytes }),
    };
    await storeState(this.outputDirectory, state);
    return state;
  }

  private async findExercise(shortName: string, signal: AbortSignal) {
    const exercises = await this.http.json<unknown>(
      `/api/programming/courses/${this.parameters.course_id}/programming-exercises`,
      { signal },
    );
    if (!Array.isArray(exercises))
      throw new Error("Artemis course exercise listing is not an array");
    const matches = exercises
      .map((item) => exerciseSchema.parse(item))
      .filter((item) => item.shortName === shortName);
    if (matches.length > 1)
      throw new Error(`Artemis course contains duplicate exercise shortName ${shortName}`);
    return matches[0];
  }

  private async ensureExercise(state: AdapterState, signal: AbortSignal): Promise<AdapterState> {
    if (state.exercise_id) return state;
    const existing = await this.findExercise(state.short_name, signal);
    const exercise =
      existing ??
      exerciseSchema.parse(
        await this.http.json<unknown>(
          "/api/programming/programming-exercises/setup?emptyRepositories=true",
          { method: "POST", body: this.exerciseDraft(state.short_name), signal },
        ),
      );
    if (exercise.shortName !== state.short_name) {
      throw new Error(
        `Artemis exercise setup returned a different shortName (expected ${JSON.stringify(state.short_name)}, observed ${JSON.stringify(exercise.shortName)})`,
      );
    }
    const next: AdapterState = { ...state, phase: "exercise_created", exercise_id: exercise.id };
    await storeState(this.outputDirectory, next);
    return next;
  }

  private exerciseDraft(shortName: string): Record<string, unknown> {
    const format = this.format;
    const identity = draftIdentity(this.request, this.parameters, format);
    const release = new Date(Date.now() + format.release_lead_ms);
    // Artemis rejects an assessment due date without a due date, so the hidden-test treatment
    // decides both.
    const dueDate = format.hidden_tests
      ? {
          dueDate: new Date(release.getTime() + 86_400_000).toISOString(),
          assessmentDueDate: new Date(release.getTime() + 2 * 86_400_000).toISOString(),
        }
      : {};
    return {
      type: "programming",
      title: this.request.case.title,
      shortName,
      ...(identity.packageName ? { packageName: identity.packageName } : {}),
      course: { id: this.parameters.course_id },
      programmingLanguage: format.language,
      ...(format.project_type ? { projectType: format.project_type } : {}),
      problemStatement: "",
      // Fixed rather than surfaced, here and in buildConfig below: no Hyperion code path reads any
      // of them, so varying them would add a treatment dimension that cannot change what is
      // generated. `difficulty` and `max_points` are format metadata for the same reason, and are
      // surfaced only because they describe the exercise a reader is handed.
      channelName: `exercise-${shortName}`,
      assessmentType: "AUTOMATIC",
      mode: "INDIVIDUAL",
      bonusPoints: 0,
      includedInOverallScore: "INCLUDED_COMPLETELY",
      allowOnlineEditor: true,
      allowOfflineIde: true,
      showTestNamesToStudents: false,
      difficulty: format.difficulty,
      maxPoints: format.max_points,
      releaseDate: release.toISOString(),
      ...dueDate,
      staticCodeAnalysisEnabled: format.static_code_analysis,
      solutionParticipation: { type: "solution" },
      templateParticipation: { type: "template" },
      buildConfig: {
        checkoutSolutionRepository: false,
        sequentialTestRuns: format.sequential_test_runs,
      },
    };
  }

  private async status(
    exerciseId: number,
    signal: AbortSignal,
  ): Promise<GenerationStatus | undefined> {
    const raw = await this.http.json<unknown>(
      `/api/hyperion/programming-exercises/${exerciseId}/generate-exercise/status`,
      { signal },
    );
    return raw === undefined ? undefined : generationStatusSchema.parse(raw);
  }

  private async ensureGenerationStarted(
    state: AdapterState,
    signal: AbortSignal,
  ): Promise<AdapterState> {
    if (!state.exercise_id) throw new Error("cannot start generation without an exercise id");
    if (state.job_id) return state;
    const existing = await this.status(state.exercise_id, signal);
    let jobId: string | undefined;
    if (existing?.jobId) {
      requireOwnedGeneration(existing, state.exercise_id);
      jobId = existing.jobId;
    }
    if (!jobId) {
      try {
        jobId = jobStartSchema.parse(
          await this.http.json<unknown>(
            `/api/hyperion/programming-exercises/${state.exercise_id}/generate-exercise`,
            {
              method: "POST",
              body: { mode: "GENERATE", prompt: this.request.case.brief },
              signal,
            },
          ),
        ).jobId;
      } catch (startError) {
        if (!(startError instanceof ArtemisHttpError && startError.status === 409))
          throw startError;
        // The 409 body names no job, so the running job can only be identified through the status.
        const reconciled = await this.status(state.exercise_id, signal).catch(() => undefined);
        if (!reconciled?.jobId) throw startError;
        requireOwnedGeneration(reconciled, state.exercise_id);
        jobId = reconciled.jobId;
      }
    }
    const next: AdapterState = { ...state, phase: "generation_started", job_id: jobId };
    await storeState(this.outputDirectory, next);
    return next;
  }

  private async waitAndCollect(
    state: AdapterState,
    signal: AbortSignal,
  ): Promise<GenerationResponse> {
    if (!state.exercise_id || !state.job_id) throw new Error("generation state is incomplete");
    const journal = await EventJournal.create(
      this.outputDirectory,
      "artemis/events.jsonl",
      this.parameters.max_event_count,
      this.parameters.max_event_bytes,
    );
    const wallDeadline = Date.parse(state.deadline_at);
    let seen: string[] = [];
    let sequence = 0;
    let settleDeadline: number | undefined;
    let finalStatus: GenerationStatus | undefined;
    try {
      for (;;) {
        if (settleDeadline === undefined && Date.now() >= wallDeadline) {
          await this.cancel(signal);
          throw new Error("Artemis generation exceeded the benchmark wall-time budget");
        }
        const status = await this.status(state.exercise_id, signal);
        if (!status) throw new Error("Artemis lost the generation status for the exercise");
        if (status.jobId !== state.job_id)
          throw new Error("Artemis status belongs to a different generation job");
        const observed = status.events.map((event) => JSON.stringify(event));
        const alignment = alignEvents(seen, observed);
        if (alignment.dropped > 0) {
          this.droppedEvents += alignment.dropped;
          sequence += 1;
          await journal.append({
            sequence,
            occurred_at: new Date().toISOString(),
            type: "artemis.events_truncated",
            publishability: "restricted",
            dropped_event_count: alignment.dropped,
            retained_event_count: observed.length,
          });
        }
        for (
          let index = observed.length - alignment.appended;
          index < observed.length;
          index += 1
        ) {
          const event = status.events[index];
          if (!event) throw new Error("Artemis event index disappeared during polling");
          sequence += 1;
          await journal.append({
            sequence,
            occurred_at: event.timestamp,
            type: `artemis.${event.type.toLowerCase()}`,
            publishability: "restricted",
            event,
          });
        }
        seen = observed;
        if (terminalEvent(status)) {
          finalStatus = status;
          if (status.accountingComplete === true) break;
          if (settleDeadline === undefined) settleDeadline = Date.now() + this.accountingSettleMs();
          else if (Date.now() >= settleDeadline) break;
        } else if (!status.running) {
          throw new Error("Artemis generation stopped without a terminal event");
        }
        const remaining = (settleDeadline ?? wallDeadline) - Date.now();
        await sleep(Math.min(this.parameters.poll_interval_ms, Math.max(1, remaining)), signal);
      }
      this.lastJournal = await journal.finalize();
    } catch (error) {
      if (journal.overflowed) await journal.discard().catch(() => undefined);
      else this.lastJournal = await journal.finalize().catch(() => undefined);
      throw error;
    }

    if (!finalStatus) throw new Error("Artemis generation has no final status");
    const terminal = terminalEvent(finalStatus);
    if (!terminal) throw new Error("Artemis generation has no terminal event");
    // Durable evidence before any measurement. A telemetry or cost-reconciliation failure must
    // never destroy a real Hyperion outcome, and must never relabel one.
    await writeJsonAtomic(
      join(this.outputDirectory, "artemis", "terminal-status.json"),
      finalStatus,
    );
    const evidenceDiagnostics = [
      ...eventDiagnostic(this.lastJournal),
      await jsonDiagnostic(
        this.outputDirectory,
        "artemis/terminal-status.json",
        "artemis-terminal-status",
      ),
    ];
    const accepted =
      terminal.type === "DONE" &&
      (terminal.completionStatus === "SUCCESS" || terminal.completionStatus === "NEEDS_REVIEW");

    if (!accepted) {
      // Artemis never records a saved exercise version for a PARTIAL completion, so the
      // repository exports below cannot be reached for it.
      const partial = terminal.type === "DONE" && terminal.completionStatus === "PARTIAL";
      const measurement = await this.measure(finalStatus, state, signal);
      return response({
        // Hyperion determined this outcome before measurement ran. Only a measurement that failed
        // to verify may override it; mere missingness may not.
        status: FAILS_CLOSED.includes(measurement.outcome) ? "infra_failed" : "failed",
        message:
          terminal.message ??
          (partial
            ? "Artemis persisted only a partial result"
            : `Artemis generation ended with ${terminal.type}`),
        completeness: partial ? "partial" : "none",
        state,
        journal: this.lastJournal,
        accounting: measurement.accounting,
        requestedSeed: this.request.attempt.seed,
        diagnostics: [...evidenceDiagnostics, ...measurement.diagnostics],
        artemis: this.terminalExtension(terminal, measurement, finalStatus),
      });
    }
    if (!terminal.savedExerciseVersionId)
      throw new Error("terminal generation event has no exact saved exercise version id");

    const version = exerciseVersionSchema.parse(
      await this.http.json<unknown>(
        `/api/exercise/exercises/${state.exercise_id}/versions/${terminal.savedExerciseVersionId}`,
        { signal },
      ),
    );
    if (version.id !== state.exercise_id)
      throw new Error("saved exercise version snapshot belongs to a different exercise");
    const identity = draftIdentity(this.request, this.parameters, this.format);
    const identityMismatches = mismatches([
      ["shortName", state.short_name, version.shortName],
      ...(identity.packageName
        ? ([["packageName", identity.packageName, version.programmingData.packageName]] as Array<
            [string, unknown, unknown]
          >)
        : []),
    ]);
    if (identityMismatches.length > 0)
      throw new Error(
        `saved exercise version changed the benchmark-controlled exercise identity (${identityMismatches.join("; ")})`,
      );
    const commits = expectedCommits(terminal);
    if (
      version.programmingData.templateParticipation.commitId !== commits.template ||
      version.programmingData.solutionParticipation.commitId !== commits.solution ||
      version.programmingData.testsCommitId !== commits.tests
    ) {
      throw new Error(
        "saved exercise version commit identities do not match the terminal generation event",
      );
    }

    const [template, solution, tests] = await Promise.all(
      (["TEMPLATE", "SOLUTION", "TESTS"] as const).map((role) =>
        this.http.bytes(
          `/api/programming/programming-exercises/${state.exercise_id}/export-instructor-repository/${role}`,
          { signal },
        ),
      ),
    );
    if (!template || !solution || !tests) throw new Error("Artemis omitted a repository export");
    const artifacts = await materializeCandidate(
      this.outputDirectory,
      version.problemStatement,
      { template, solution, tests },
      {
        maxBytes: this.parameters.max_artifact_bytes,
        maxFiles: this.parameters.max_archive_files,
        maxRatio: this.parameters.max_archive_ratio,
      },
    );
    await verifyExportedRepositoryCommits(this.outputDirectory, commits);
    const terminalState: AdapterState = {
      ...state,
      phase: "terminal",
      terminal_version_id: terminal.savedExerciseVersionId,
    };
    await storeState(this.outputDirectory, terminalState);
    this.state = terminalState;
    await writeJsonAtomic(join(this.outputDirectory, "artemis", "generation-evidence.json"), {
      exercise_id: state.exercise_id,
      job_id: state.job_id,
      exact_exercise_version_id: terminal.savedExerciseVersionId,
      exact_version: version,
      terminal_event: terminal,
      event_journal: this.lastJournal,
    });
    // The candidate is on disk and verified. Only now may the measurement planes run.
    const measurement = await this.measure(finalStatus, state, signal);
    const completeAccounting = measurement.accounting;
    const models = completeAccounting?.models ?? finalStatus.usage?.models ?? [];
    const diagnostics = [
      ...evidenceDiagnostics,
      await jsonDiagnostic(
        this.outputDirectory,
        "artemis/generation-evidence.json",
        "artemis-generation-evidence",
      ),
      ...measurement.diagnostics,
    ];

    return generationResponseSchema.parse({
      protocol_version: GENERATION_PROTOCOL_VERSION,
      // Hyperion succeeded and the candidate is captured, so capture stays complete and the
      // artifacts stay on the response even when a measurement plane failed.
      status: measurement.outcome === "captured" ? "succeeded" : "infra_failed",
      artifacts,
      diagnostics,
      capture: { completeness: "complete" },
      ...(terminal.message ? { message: terminal.message } : {}),
      ...(completeAccounting
        ? {
            usage: completeAccounting.usage,
            ...(completeAccounting.cost ? { cost: completeAccounting.cost } : {}),
          }
        : {}),
      ...this.modelBlock(models),
      execution: {
        requested_seed: this.request.attempt.seed,
        seed_status: "unsupported",
        effective_parameters: { exercise_format: this.format, model: models },
        ...this.budgetShapedLimits(finalStatus),
        provider_request_ids: completeAccounting?.providerRequestIds ?? [],
        provider_request_ids_complete: completeAccounting?.providerRequestIdsComplete ?? false,
      },
      extensions: {
        artemis: {
          exercise_id: state.exercise_id,
          job_id: state.job_id,
          exact_exercise_version_id: terminal.savedExerciseVersionId,
          saved_repository_commits: commits,
          evidence_path: "artemis/generation-evidence.json",
          usage_accounting_complete: Boolean(completeAccounting),
          models,
          ...this.terminalExtension(terminal, measurement, finalStatus),
        },
      },
    });
  }

  /**
   * Artemis reports the model identifiers a job used but never which endpoint served them, so the
   * provider stays an operator declaration rather than something inferred from the identifier.
   */
  private modelBlock(models: string[]): Record<string, unknown> {
    const provider = this.parameters.model_provider;
    const id = models.length === 1 ? models[0] : undefined;
    return provider && id ? { model: { provider, id } } : {};
  }

  /**
   * The protocol's limit block carries only the harness budget dimensions and no source, so it gets
   * the two Artemis knobs that map onto a dimension and only when their value is actually known.
   * `extensions.artemis.effective_limits` stays the complete, sourced record; both are derived here
   * so they cannot disagree.
   */
  private budgetShapedLimits(status: GenerationStatus): Record<string, unknown> {
    const known = new Map(
      this.effectiveLimits(status)
        .filter((limit) => limit.value !== undefined)
        .map((limit) => [limit.id, limit.value] as const),
    );
    const limits = {
      ...(known.has("max_job_duration_ms")
        ? { wall_time_ms: known.get("max_job_duration_ms") }
        : {}),
      ...(known.has("max_tokens_per_job") ? { total_tokens: known.get("max_tokens_per_job") } : {}),
    };
    return Object.keys(limits).length > 0 ? { effective_limits: limits } : {};
  }

  private effectiveLimits(status: GenerationStatus | undefined): EffectiveLimit[] {
    const configured = this.parameters.server_limits ?? {};
    const reported = status?.limits ?? {};
    return (
      [
        "max_job_duration_ms",
        "max_tokens_per_job",
        "max_turns",
        "context_window_tokens",
        "admission_max_tokens_per_user",
      ] as const
    ).map((id) => {
      const value = reported[id] ?? configured[id];
      if (value === undefined) return { id, source: "unknown" as const };
      return {
        id,
        source: reported[id] === undefined ? ("system_configured" as const) : "system_reported",
        value,
      };
    });
  }

  private terminalExtension(
    terminal: GenerationEvent,
    measurement: Measurement,
    finalStatus: GenerationStatus,
  ): Record<string, unknown> {
    return {
      completion_status: terminal.completionStatus ?? "none",
      termination_reason: terminal.terminationReason ?? "unknown",
      ...this.eventTruncationExtension(),
      ...(measurement.accounting ? {} : { usage_accounting_gap: ACCOUNTING_GAP }),
      cost_reconciliation_configured: measurement.costReconciliationConfigured,
      cost_verified: measurement.costVerified,
      effective_limits: this.effectiveLimits(finalStatus),
      measurement: {
        outcome: measurement.outcome,
        ...(measurement.reason ? { reason: measurement.reason } : {}),
      },
      ...(measurement.telemetry ? { telemetry: telemetryExtension(measurement.telemetry) } : {}),
    };
  }
}

function ownedGeneration(status: GenerationStatus): boolean {
  return status.ownedByCaller === true && status.mode === "GENERATE";
}

function requireOwnedGeneration(status: GenerationStatus, exerciseId: number): void {
  if (ownedGeneration(status)) return;
  throw new Error(
    `Artemis exercise ${exerciseId} already runs generation job ${status.jobId} that this attempt must not adopt (ownedByCaller=${status.ownedByCaller}, mode=${status.mode})`,
  );
}
