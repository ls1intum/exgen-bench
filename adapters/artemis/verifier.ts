#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../../src/core/files.ts";
import { digestJson } from "../../src/core/canonical.ts";
import { evaluationSuiteSchema, evaluatorIdentitySchema } from "../../src/evaluation/contracts.ts";
import { artemisParametersSchema, resolveAuthorization } from "./config.ts";
import { ArtemisHttpClient, sleep } from "./http.ts";

const candidateSchema = z
  .object({
    problem_statement: z.string(),
    template: z.record(z.string(), z.string()),
    solution: z.record(z.string(), z.string()),
    tests: z.record(z.string(), z.string()),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const artemisVerificationRequestSchema = z
  .object({
    protocol_version: z.literal("1"),
    attempt_id: z.string().min(1),
    target: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1),
        revision: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    verifier_profile: z.string().min(1),
    evaluator: evaluatorIdentitySchema,
    suite: evaluationSuiteSchema,
    budget: z.object({ wall_time_ms: z.number().int().positive() }).passthrough(),
    parameters: artemisParametersSchema,
    candidate: candidateSchema,
  })
  .strict();

export const artemisVerificationResponseSchema = z
  .object({
    protocol_version: z.literal("1"),
    status: z.enum(["passed", "failed", "error"]),
    run_id: z.string().min(1),
    verifier_profile: z.string().min(1),
    evaluator: evaluatorIdentitySchema,
    suite: evaluationSuiteSchema,
    report: z.record(z.string(), z.unknown()),
    provenance: z.record(z.string(), z.unknown()).default({}),
    events: z.array(z.unknown()).default([]),
  })
  .strict();

export type ArtemisVerificationRequest = z.infer<typeof artemisVerificationRequestSchema>;
export type ArtemisVerificationResponse = z.infer<typeof artemisVerificationResponseSchema>;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

export class ArtemisVerifier {
  private readonly http: ArtemisHttpClient;
  private runId: string | undefined;

  constructor(
    private readonly request: ArtemisVerificationRequest,
    private readonly outputDirectory: string,
  ) {
    this.http = new ArtemisHttpClient(
      request.parameters.base_url,
      resolveAuthorization(request.parameters),
      request.parameters.request_timeout_ms,
      request.parameters.max_http_retries,
      request.parameters.max_http_response_bytes,
    );
  }

  async cancel(): Promise<void> {
    if (!this.runId) {
      return;
    }
    await this.http
      .json(`/api/hyperion/verification/runs/${encodeURIComponent(this.runId)}/cancel`, {
        method: "POST",
      })
      .catch(() => undefined);
  }

  async verify(signal: AbortSignal): Promise<ArtemisVerificationResponse> {
    const cancelOnAbort = (): void => {
      void this.cancel();
    };
    signal.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      return await this.verifyRun(signal);
    } finally {
      signal.removeEventListener("abort", cancelOnAbort);
      if (signal.aborted) {
        await this.cancel();
      }
    }
  }

  private async verifyRun(signal: AbortSignal): Promise<ArtemisVerificationResponse> {
    if (this.request.parameters.api_mode !== "research") {
      throw new Error(
        "canonical verifier bridge requires api_mode=research; the legacy pilot has no immutable candidate verification API",
      );
    }
    const capabilities = recordOf(
      await this.http.json<unknown>("/api/hyperion/verification/capabilities", {
        signal,
      }),
    );
    if (
      stringOf(capabilities?.protocol_version) !== "1" ||
      capabilities?.durable_runs !== true ||
      capabilities.canonical_candidate_verifier !== true ||
      capabilities.idempotent_start !== true ||
      capabilities.sequenced_events !== true ||
      capabilities.cancellation !== true
    ) {
      throw new Error(
        "Artemis does not advertise durable, idempotent, cancellable canonical verification protocol v1 with sequenced events",
      );
    }

    const statePath = join(this.outputDirectory, "artemis-verifier", "state.json");
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        attempt_id?: unknown;
        run_id?: unknown;
      };
      if (state.attempt_id !== this.request.attempt_id || typeof state.run_id !== "string") {
        throw new Error("verifier state does not match this attempt");
      }
      this.runId = state.run_id;
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }

    if (!this.runId) {
      const started = recordOf(
        await this.http.json<unknown>("/api/hyperion/verification/runs", {
          method: "POST",
          headers: { "idempotency-key": this.request.attempt_id },
          body: {
            protocol_version: "1",
            client_attempt_id: this.request.attempt_id,
            target: this.request.target,
            verifier_profile: this.request.verifier_profile,
            evaluator: this.request.evaluator,
            suite: this.request.suite,
            candidate: this.request.candidate,
          },
          signal,
          retry: true,
        }),
      );
      this.runId = stringOf(started?.runId) ?? stringOf(started?.run_id);
      if (!this.runId) {
        throw new Error("Artemis verifier start response did not contain runId");
      }
      await writeJsonAtomic(statePath, {
        schema_version: "1",
        attempt_id: this.request.attempt_id,
        run_id: this.runId,
      });
    }

    const deadline = Date.now() + this.request.budget.wall_time_ms;
    let sequence = 0;
    const events: unknown[] = [];
    let terminal: Record<string, unknown> | undefined;
    for (;;) {
      if (Date.now() >= deadline) {
        await this.cancel();
        throw new Error("Artemis canonical verification exceeded its wall-time budget");
      }
      const status = recordOf(
        await this.http.json<unknown>(
          `/api/hyperion/verification/runs/${encodeURIComponent(this.runId)}`,
          { signal },
        ),
      );
      const page = recordOf(
        await this.http.json<unknown>(
          `/api/hyperion/verification/runs/${encodeURIComponent(this.runId)}/events?after=${sequence}`,
          { signal },
        ),
      );
      for (const event of Array.isArray(page?.events) ? page.events : []) {
        const eventSequence = recordOf(event)?.sequence;
        if (
          typeof eventSequence !== "number" ||
          !Number.isSafeInteger(eventSequence) ||
          eventSequence <= sequence
        ) {
          throw new Error("Artemis verifier returned an unsequenced or non-monotonic event");
        }
        events.push(event);
        sequence = eventSequence;
      }
      const state = stringOf(status?.state)?.toUpperCase();
      if (state && ["PASSED", "FAILED", "ERROR", "COMPLETED"].includes(state)) {
        terminal = status;
        break;
      }
      await sleep(
        Math.min(this.request.parameters.poll_interval_ms, Math.max(1, deadline - Date.now())),
        signal,
      );
    }
    const evidence = recordOf(
      await this.http.json<unknown>(
        `/api/hyperion/verification/runs/${encodeURIComponent(this.runId)}/evidence`,
        { signal },
      ),
    );
    if (!terminal) {
      throw new Error("Artemis verifier ended without terminal status");
    }
    const report = recordOf(evidence?.report) ?? recordOf(terminal.report);
    if (!report) {
      throw new Error("Artemis verifier returned no structured report");
    }
    const echoedEvaluator = evaluatorIdentitySchema.parse(
      evidence?.evaluator ?? terminal.evaluator,
    );
    const echoedSuite = evaluationSuiteSchema.parse(evidence?.suite ?? terminal.suite);
    if (digestJson(echoedEvaluator) !== digestJson(this.request.evaluator)) {
      throw new Error("Artemis verifier echoed a different evaluator identity");
    }
    if (digestJson(echoedSuite) !== digestJson(this.request.suite)) {
      throw new Error("Artemis verifier echoed a different evaluation suite");
    }
    const terminalState = stringOf(terminal.state)?.toUpperCase();
    const terminalOutcome =
      stringOf(terminal.outcome)?.toUpperCase() ?? stringOf(terminal.result)?.toUpperCase();
    const effectiveOutcome = terminalState === "COMPLETED" ? terminalOutcome : terminalState;
    const response = artemisVerificationResponseSchema.parse({
      protocol_version: "1",
      status:
        effectiveOutcome === "PASSED" || effectiveOutcome === "SUCCESS"
          ? "passed"
          : effectiveOutcome === "FAILED" || effectiveOutcome === "REJECTED"
            ? "failed"
            : "error",
      run_id: this.runId,
      verifier_profile: this.request.verifier_profile,
      evaluator: echoedEvaluator,
      suite: echoedSuite,
      report,
      provenance: recordOf(evidence?.provenance) ?? {},
      events,
    });
    await writeJsonAtomic(join(this.outputDirectory, "verification-response.json"), response);
    await writeJsonAtomic(join(this.outputDirectory, "artemis-verifier", "evidence.json"), {
      terminal,
      evidence,
      events,
    });
    return response;
  }
}

if (import.meta.main) {
  if (process.argv[2] !== "verify") {
    throw new Error("usage: verifier.ts verify --request PATH --output DIRECTORY");
  }
  const request = artemisVerificationRequestSchema.parse(
    await Bun.file(resolve(option("--request"))).json(),
  );
  const outputDirectory = resolve(option("--output"));
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("verifier received a signal"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const verifier = new ArtemisVerifier(request, outputDirectory);
  try {
    await verifier.verify(controller.signal);
  } finally {
    if (controller.signal.aborted) {
      await verifier.cancel();
    }
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
