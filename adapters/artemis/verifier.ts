#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { digestJson } from "../../src/core/canonical.ts";
import { writeJsonAtomic } from "../../src/core/files.ts";
import { evaluationSuiteSchema, evaluatorIdentitySchema } from "../../src/evaluation/contracts.ts";
import { artemisParametersSchema, resolveAuthorization } from "./config.ts";
import { EventJournal, type EventJournalSummary } from "./events.ts";
import { ArtemisHttpClient, sleep } from "./http.ts";
import {
  eventPageSchema,
  runReferenceSchema,
  textTreeSchema,
  type VerificationRun,
  verificationCapabilitiesSchema,
  verificationEvidenceSchema,
  verificationProvenanceSchema,
  verificationRunResult,
  verificationRunSchema,
} from "./protocol.ts";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const candidateSchema = z
  .object({
    problem_statement: z.string(),
    template: textTreeSchema,
    solution: textTreeSchema,
    tests: textTreeSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const artemisVerificationRequestSchema = z
  .object({
    protocol_version: z.literal("1"),
    attempt_id: z.string().min(1),
    candidate_digest: digestSchema,
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
    provenance: verificationProvenanceSchema,
    event_journal: z
      .object({
        path: z.string().min(1),
        count: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type ArtemisVerificationRequest = z.infer<typeof artemisVerificationRequestSchema>;
export type ArtemisVerificationResponse = z.infer<typeof artemisVerificationResponseSchema>;

const verifierStateSchema = z
  .object({
    schema_version: z.literal("2"),
    attempt_id: z.string().min(1),
    run_id: z.string().min(1).optional(),
    started_at: z.string().datetime({ offset: true }),
    deadline_at: z.string().datetime({ offset: true }),
  })
  .strict();

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
      request.parameters.max_http_total_bytes,
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
    const statePath = join(this.outputDirectory, "artemis-verifier", "state.json");
    let state: z.infer<typeof verifierStateSchema>;
    try {
      state = verifierStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
      if (state.attempt_id !== this.request.attempt_id) {
        throw new Error("verifier state does not match this attempt");
      }
      this.runId = state.run_id;
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      const startedAt = new Date();
      state = verifierStateSchema.parse({
        schema_version: "2",
        attempt_id: this.request.attempt_id,
        started_at: startedAt.toISOString(),
        deadline_at: new Date(startedAt.getTime() + this.request.budget.wall_time_ms).toISOString(),
      });
      await writeJsonAtomic(statePath, state);
    }

    const deadline = Date.parse(state.deadline_at);
    if (Date.now() >= deadline) {
      await this.cancel();
      throw new Error("Artemis canonical verification exceeded its wall-time budget");
    }

    const capabilities = verificationCapabilitiesSchema.safeParse(
      await this.http.json<unknown>("/api/hyperion/verification/capabilities", {
        signal,
      }),
    );
    if (!capabilities.success) {
      throw new Error(
        "Artemis does not advertise durable, idempotent, cancellable canonical verification protocol v1 with sequenced events",
        { cause: capabilities.error },
      );
    }

    if (!this.runId) {
      const started = runReferenceSchema.parse(
        await this.http.json<unknown>("/api/hyperion/verification/runs", {
          method: "POST",
          headers: { "idempotency-key": this.request.attempt_id },
          body: {
            protocol_version: "1",
            client_attempt_id: this.request.attempt_id,
            candidate_digest: this.request.candidate_digest,
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
      this.runId = started.runId;
      await writeJsonAtomic(statePath, {
        ...state,
        run_id: this.runId,
      });
    }

    let sequence = 0;
    let terminal: VerificationRun | undefined;
    const eventJournal = await EventJournal.create(
      this.outputDirectory,
      "artemis-verifier/events.jsonl",
      this.request.parameters.max_event_count,
      this.request.parameters.max_event_bytes,
    );
    let eventJournalSummary: EventJournalSummary;
    try {
      for (;;) {
        if (Date.now() >= deadline) {
          await this.cancel();
          throw new Error("Artemis canonical verification exceeded its wall-time budget");
        }
        const status = verificationRunSchema.parse(
          await this.http.json<unknown>(
            `/api/hyperion/verification/runs/${encodeURIComponent(this.runId)}`,
            { signal },
          ),
        );
        if (status.runId !== this.runId) {
          throw new Error("Artemis verifier status echoed a different runId");
        }
        if (status.client_attempt_id !== this.request.attempt_id) {
          throw new Error("Artemis verifier status echoed a different client_attempt_id");
        }
        const terminalStatus = ["PASSED", "FAILED", "ERROR", "COMPLETED"].includes(status.state);
        for (;;) {
          const page = eventPageSchema.parse(
            await this.http.json<unknown>(
              `/api/hyperion/verification/runs/${encodeURIComponent(this.runId)}/events?after=${sequence}`,
              { signal },
            ),
          );
          for (const event of page.events) {
            if (event.sequence <= sequence) {
              throw new Error("Artemis verifier returned an unsequenced or non-monotonic event");
            }
            await eventJournal.append(event);
            sequence = event.sequence;
          }
          if (!terminalStatus || page.events.length === 0) {
            break;
          }
        }
        if (terminalStatus) {
          terminal = status;
          break;
        }
        await sleep(
          Math.min(this.request.parameters.poll_interval_ms, Math.max(1, deadline - Date.now())),
          signal,
        );
      }
      eventJournalSummary = await eventJournal.finalize();
    } catch (error) {
      await eventJournal.discard();
      throw error;
    }
    const evidence = verificationEvidenceSchema.parse(
      await this.http.json<unknown>(
        `/api/hyperion/verification/runs/${encodeURIComponent(this.runId)}/evidence`,
        { signal },
      ),
    );
    if (!terminal) {
      throw new Error("Artemis verifier ended without terminal status");
    }
    if (evidence.runId !== this.runId) {
      throw new Error("Artemis verifier evidence echoed a different runId");
    }
    if (evidence.client_attempt_id !== this.request.attempt_id) {
      throw new Error("Artemis verifier evidence echoed a different client_attempt_id");
    }
    if (evidence.candidate_digest !== this.request.candidate_digest) {
      throw new Error("Artemis verifier evidence echoed a different candidate digest");
    }
    const echoedEvaluator = evidence.evaluator;
    const echoedSuite = evidence.suite;
    if (digestJson(echoedEvaluator) !== digestJson(this.request.evaluator)) {
      throw new Error("Artemis verifier echoed a different evaluator identity");
    }
    if (digestJson(echoedSuite) !== digestJson(this.request.suite)) {
      throw new Error("Artemis verifier echoed a different evaluation suite");
    }
    if (evidence.provenance.verifier_revision !== this.request.evaluator.revision) {
      throw new Error("Artemis verifier provenance echoed a different verifier revision");
    }
    const response = artemisVerificationResponseSchema.parse({
      protocol_version: "1",
      status: verificationRunResult(terminal),
      run_id: this.runId,
      verifier_profile: this.request.verifier_profile,
      evaluator: echoedEvaluator,
      suite: echoedSuite,
      report: evidence.report,
      provenance: evidence.provenance,
      event_journal: eventJournalSummary,
    });
    await writeJsonAtomic(join(this.outputDirectory, "verification-response.json"), response);
    await writeJsonAtomic(join(this.outputDirectory, "artemis-verifier", "evidence.json"), {
      terminal,
      evidence,
      event_journal: eventJournalSummary,
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
