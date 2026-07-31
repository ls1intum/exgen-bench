import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtemisGenerator } from "../adapters/artemis/client.ts";
import { artemisParametersSchema } from "../adapters/artemis/config.ts";
import {
  type ArtemisEvaluationOptions,
  createArtemisEvaluationExecutor,
  evaluateCandidateWithArtemis,
} from "../adapters/artemis/evaluation.ts";
import {
  ArtemisVerifier,
  artemisVerificationRequestSchema,
  recoverArtemisVerification,
} from "../adapters/artemis/verifier.ts";
import { validateAndDigestArtifacts } from "../src/adapters/artifacts.ts";
import {
  type GenerationRequest,
  generationRequestSchema,
  generationResponseSchema,
} from "../src/contracts.ts";
import { evaluationRequestSchema } from "../src/evaluation/contracts.ts";

interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop(true);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-artemis-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function startMock(
  handler: (request: Request, recorded: RecordedRequest[]) => Response | Promise<Response>,
): { baseUrl: string; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: unknown;
      if (request.method !== "GET" && request.headers.get("content-length") !== "0") {
        const text = await request.text();
        body = text ? JSON.parse(text) : undefined;
      }
      recorded.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: new Headers(request.headers),
        body,
      });
      return handler(request, recorded);
    },
  });
  servers.push(server);
  return { baseUrl: server.url.origin, recorded };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

const occurredAt = "2026-01-01T00:00:00Z";
const artifactDigest = "c".repeat(64);
const environment = {
  image_digest: `sha256:${"f".repeat(64)}`,
  toolchain_digest: "b".repeat(64),
};

function generationProvenance(artemisRevision = "test-revision"): Record<string, unknown> {
  return {
    artemis_revision: artemisRevision,
    prompt_digest: "e".repeat(64),
    environment,
  };
}

function verificationProvenance(): Record<string, unknown> {
  return {
    artemis_revision: "artemis-revision",
    verifier_revision: "verifier-revision",
    environment,
  };
}

function effectiveExecution(seed = 42): Record<string, unknown> {
  return {
    requested_seed: seed,
    seed_status: "honored",
    effective_seed: seed,
    effective_parameters: {},
    provider_request_ids: [],
    provider_request_ids_complete: true,
  };
}

function generationStatus(runId: string, state: string, outcome?: string): Record<string, unknown> {
  return {
    runId,
    client_attempt_id: "obs-test-1",
    state,
    ...(outcome ? { outcome } : {}),
    approach: {
      id: "hyperion.full",
      version: "1",
      implementation_digest: `sha256:${"a".repeat(64)}`,
    },
    provenance: generationProvenance(),
    effective_execution: effectiveExecution(),
  };
}

function verificationStatus(
  runId: string,
  attemptId: string,
  state: string,
  outcome?: string,
): Record<string, unknown> {
  return {
    runId,
    client_attempt_id: attemptId,
    state,
    ...(outcome ? { outcome } : {}),
  };
}

function requestFor(
  outputDirectory: string,
  baseUrl: string,
  parameters: Record<string, unknown> = {},
): GenerationRequest {
  return generationRequestSchema.parse({
    protocol_version: "1",
    attempt: { id: "obs-test-1", replicate: 1, seed: 42 },
    case: {
      id: "return-answer",
      title: "Return answer",
      brief: "Create a Java exercise that returns 42.",
      tags: ["java"],
    },
    target: {
      id: "artemis-java-maven",
      version: "1",
      revision: "test",
      parameters: {},
    },
    budget: { wall_time_ms: 2_000, max_model_calls: 4 },
    parameters: {
      base_url: baseUrl,
      auth: { type: "none" },
      poll_interval_ms: 1,
      ...parameters,
    },
    output_dir: outputDirectory,
  });
}

function verificationRequestFor(
  baseUrl: string,
  attemptId = "obs-test-1",
  parameters: Record<string, unknown> = {},
) {
  return artemisVerificationRequestSchema.parse({
    protocol_version: "1",
    attempt_id: attemptId,
    candidate_digest: artifactDigest,
    target: {
      id: "artemis-java-maven",
      version: "1",
      revision: "target-sha",
      parameters: {},
    },
    verifier_profile: "artemis-java-v1",
    evaluator: {
      id: "artemis-canonical",
      version: "1",
      revision: "verifier-revision",
      target_profile: "artemis-java-v1",
      implementation_digest: "d".repeat(64),
    },
    suite: {
      id: "primary",
      version: "1",
      digest: "e".repeat(64),
    },
    budget: { wall_time_ms: 2_000 },
    parameters: {
      base_url: baseUrl,
      auth: { type: "none" },
      poll_interval_ms: 1,
      ...parameters,
    },
    candidate: {
      problem_statement: "Return 42.",
      template: { "A.java": "class A {}" },
      solution: { "A.java": "class A {}" },
      tests: { "ATest.java": "class ATest {}" },
    },
  });
}

describe("Artemis benchmark adapter", () => {
  test("requires encrypted transport for bearer credentials outside loopback", () => {
    expect(
      artemisParametersSchema.safeParse({
        base_url: "http://artemis.example.edu",
        auth: { type: "bearer", token_env: "TEST_TOKEN" },
      }).success,
    ).toBe(false);
    expect(
      artemisParametersSchema.safeParse({
        base_url: "http://127.0.0.1:8080",
        auth: { type: "bearer", token_env: "TEST_TOKEN" },
      }).success,
    ).toBe(true);
  });

  test("classifies an unavailable Artemis API as infrastructure missingness", async () => {
    const output = await fixtureDirectory();
    const { baseUrl } = startMock(() => json({ error: "unavailable" }, 503));

    const response = await new ArtemisGenerator(
      requestFor(output, baseUrl, { max_http_retries: 0 }),
      output,
    ).generate(new AbortController().signal);

    expect(response).toMatchObject({
      status: "infra_failed",
      capture: { completeness: "none" },
    });
    expect(response.message).toContain("HTTP 503");
  });

  test("bounds cumulative HTTP response bytes across a generation run", async () => {
    const output = await fixtureDirectory();
    const status = generationStatus("bounded-run", "RUNNING");
    const limit = Buffer.byteLength(JSON.stringify(status)) + 100;
    const { baseUrl } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          idempotent_start: true,
          artifact_bundle: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/generation/runs") {
        return json({ runId: "bounded-run" }, 202);
      }
      return json(status);
    });

    const response = await new ArtemisGenerator(
      requestFor(output, baseUrl, {
        max_http_response_bytes: limit,
        max_http_total_bytes: limit,
      }),
      output,
    ).generate(new AbortController().signal);

    expect(response.status).toBe("infra_failed");
    expect(response.message).toContain("cumulative limit");
  });

  test("rejects obsolete adapter state instead of reinterpreting its remote ID", async () => {
    const output = await fixtureDirectory();
    await mkdir(join(output, "artemis"), { recursive: true });
    await writeFile(
      join(output, "artemis", "adapter-state.json"),
      JSON.stringify({
        schema_version: "1",
        attempt_id: "obs-test-1",
        remote_id: "obsolete-run",
      }),
    );
    const { baseUrl, recorded } = startMock(() => json({ error: "unexpected request" }, 500));

    const response = await new ArtemisGenerator(requestFor(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(response.status).toBe("infra_failed");
    expect(response.message).toContain("adapter state does not match");
    expect(recorded).toHaveLength(0);
  });

  test("negotiates durable API, starts idempotently, and retains structured evidence", async () => {
    const output = await fixtureDirectory();
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          idempotent_start: true,
          artifact_bundle: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/generation/runs" && request.method === "POST") {
        return json({ runId: "run-1" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        const after = url.searchParams.get("after");
        return json({
          events:
            after === "0"
              ? [{ sequence: 1, occurred_at: occurredAt, type: "RUN_STARTED" }]
              : after === "1"
                ? [{ sequence: 2, occurred_at: occurredAt, type: "RUN_FINISHED" }]
                : [],
        });
      }
      if (url.pathname.endsWith("/bundle")) {
        return json({
          capture: { completeness: "complete" },
          candidate: {
            problem_statement: "# Return 42",
            template: { "src/Answer.java": "class Answer { int value() { return 0; } }" },
            solution: { "src/Answer.java": "class Answer { int value() { return 42; } }" },
            tests: { "src/AnswerTest.java": "class AnswerTest {}" },
          },
          verification: { status: "PASSED" },
        });
      }
      if (url.pathname.endsWith("/run-1")) {
        return json({
          ...generationStatus("run-1", "SUCCEEDED", "SUCCEEDED"),
          approach: {
            id: "external.experimental",
            version: "3",
            implementation_digest: `sha256:${"a".repeat(64)}`,
          },
          provenance: generationProvenance("abc123"),
          model: { provider: "test", id: "model-1" },
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          telemetry: { model_calls: 1 },
        });
      }
      return json({ error: "not found" }, 404);
    });
    const request = requestFor(output, baseUrl, {
      approach: { id: "external.experimental", version: "3" },
    });

    const response = await new ArtemisGenerator(request, output).generate(
      new AbortController().signal,
    );
    const resumed = await new ArtemisGenerator(request, output).generate(
      new AbortController().signal,
    );

    expect(generationResponseSchema.parse(response).status).toBe("succeeded");
    expect(resumed.status).toBe("succeeded");
    expect(response.capture.completeness).toBe("complete");
    expect(response.artifacts.map((artifact) => artifact.role)).toEqual([
      "problem_statement",
      "template",
      "solution",
      "tests",
    ]);
    expect(
      await readFile(join(output, "artifacts", "solution", "src", "Answer.java"), "utf8"),
    ).toContain("42");
    const start = recorded.find((entry) => entry.path === "/api/hyperion/generation/runs");
    expect(recorded.filter((entry) => entry.path === "/api/hyperion/generation/runs")).toHaveLength(
      1,
    );
    expect(start?.headers.get("idempotency-key")).toBe("obs-test-1");
    expect((start?.body as { approach?: { id?: string } } | undefined)?.approach?.id).toBe(
      "external.experimental",
    );
    const evidence = JSON.parse(
      await readFile(join(output, "artemis", "generation-evidence.json"), "utf8"),
    ) as { event_journal: { count: number; path: string } };
    expect(evidence.event_journal).toMatchObject({
      count: 2,
      path: "artemis/events.jsonl",
    });
    expect(await readFile(join(output, "artemis", "events.jsonl"), "utf8")).toContain(
      "RUN_STARTED",
    );
    expect(
      JSON.parse(await readFile(join(output, "artemis", "adapter-state.json"), "utf8")),
    ).toMatchObject({ schema_version: "2", remote_id: "run-1" });
    expect(recorded.some((entry) => entry.path.endsWith("/events?after=2"))).toBe(true);
  });

  test("retains a failed candidate when the benchmark API captured it", async () => {
    const output = await fixtureDirectory();
    const { baseUrl } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          idempotent_start: true,
          artifact_bundle: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/generation/runs") {
        return json({ runId: "failed-run" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        return json({ events: [] });
      }
      if (url.pathname.endsWith("/bundle")) {
        return json({
          capture: { completeness: "complete", reason: "verification failed" },
          candidate: {
            problem_statement: "Broken candidate",
            template: { "A.java": "class A {}" },
            solution: { "A.java": "class A {" },
            tests: { "ATest.java": "class ATest {}" },
          },
        });
      }
      return json({
        ...generationStatus("failed-run", "FAILED", "FAILED"),
        failure: { message: "compilation failed" },
      });
    });

    const response = await new ArtemisGenerator(requestFor(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(response.status).toBe("failed");
    expect(response.capture.completeness).toBe("complete");
    expect(response.artifacts).toHaveLength(4);
    expect(response.message).toBe("compilation failed");
  });

  test("cancels the durable remote run when the attempt budget expires", async () => {
    const output = await fixtureDirectory();
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          idempotent_start: true,
          artifact_bundle: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/generation/runs") {
        return json({ runId: "slow-run" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        return json({ events: [] });
      }
      if (url.pathname.endsWith("/cancel")) {
        return json({ state: "CANCELLING" }, 202);
      }
      return json(generationStatus("slow-run", "RUNNING"));
    });
    const baseRequest = requestFor(output, baseUrl);
    const request = generationRequestSchema.parse({
      ...baseRequest,
      budget: { wall_time_ms: 25 },
    });

    const response = await new ArtemisGenerator(request, output).generate(
      new AbortController().signal,
    );

    expect(response.status).toBe("infra_failed");
    expect(
      recorded.some(
        (entry) =>
          entry.method === "POST" && entry.path === "/api/hyperion/generation/runs/slow-run/cancel",
      ),
    ).toBe(true);
  });

  test("recovers a remote run by stable attempt ID without starting another generation", async () => {
    const output = await fixtureDirectory();
    let cancelled = false;
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/by-client-attempt/obs-test-1")) {
        return json({ runId: "orphan-run" });
      }
      if (url.pathname.endsWith("/orphan-run/cancel")) {
        cancelled = true;
        return json({ state: "CANCELLING" }, 202);
      }
      if (url.pathname.endsWith("/orphan-run")) {
        return json(generationStatus("orphan-run", cancelled ? "CANCELLED" : "RUNNING"));
      }
      return json({ error: "not found" }, 404);
    });

    await new ArtemisGenerator(requestFor(output, baseUrl), output).recover(
      new AbortController().signal,
    );

    expect(
      recorded.filter(
        (entry) =>
          entry.method === "POST" &&
          entry.path === "/api/hyperion/generation/runs/orphan-run/cancel",
      ),
    ).toHaveLength(1);
    expect(
      recorded.some(
        (entry) => entry.method === "POST" && entry.path === "/api/hyperion/generation/runs",
      ),
    ).toBe(false);
  });

  for (const scenario of [
    {
      name: "a different runId",
      status: {
        ...generationStatus("different-run", "SUCCEEDED", "SUCCEEDED"),
        client_attempt_id: "obs-test-1",
      },
      expected: "different runId",
    },
    {
      name: "a different client_attempt_id",
      status: {
        ...generationStatus("strict-run", "SUCCEEDED", "SUCCEEDED"),
        client_attempt_id: "different-attempt",
      },
      expected: "different client_attempt_id",
    },
    {
      name: "a contradictory terminal outcome",
      status: generationStatus("strict-run", "SUCCEEDED", "FAILED"),
      expected: "contradict",
    },
    {
      name: "a different approach identity",
      status: {
        ...generationStatus("strict-run", "SUCCEEDED", "SUCCEEDED"),
        approach: {
          id: "hyperion.other",
          version: "1",
          implementation_digest: `sha256:${"a".repeat(64)}`,
        },
      },
      expected: "different approach identity",
    },
    {
      name: "a different requested seed",
      status: {
        ...generationStatus("strict-run", "SUCCEEDED", "SUCCEEDED"),
        effective_execution: effectiveExecution(7),
      },
      expected: "different requested seed",
    },
    {
      name: "an honored seed that was not honored",
      status: {
        ...generationStatus("strict-run", "SUCCEEDED", "SUCCEEDED"),
        effective_execution: {
          ...effectiveExecution(),
          effective_seed: 7,
        },
      },
      expected: "must equal the requested seed",
    },
    {
      name: "missing execution provenance",
      status: (() => {
        const { provenance: _, ...status } = generationStatus(
          "strict-run",
          "SUCCEEDED",
          "SUCCEEDED",
        );
        return status;
      })(),
      expected: "provenance",
    },
  ]) {
    test(`rejects generation status with ${scenario.name}`, async () => {
      const output = await fixtureDirectory();
      const { baseUrl } = startMock((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/capabilities")) {
          return json({
            protocol_version: "1",
            durable_runs: true,
            idempotent_start: true,
            artifact_bundle: true,
            sequenced_events: true,
            cancellation: true,
          });
        }
        if (url.pathname === "/api/hyperion/generation/runs") {
          return json({ runId: "strict-run" }, 202);
        }
        return json(scenario.status);
      });

      const response = await new ArtemisGenerator(requestFor(output, baseUrl), output).generate(
        new AbortController().signal,
      );

      expect(response.status).toBe("infra_failed");
      expect(response.message).toContain(scenario.expected);
    });
  }

  test("does not reinterpret a flat generation bundle as a candidate", async () => {
    const output = await fixtureDirectory();
    const { baseUrl } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          idempotent_start: true,
          artifact_bundle: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/generation/runs") {
        return json({ runId: "flat-run" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        return json({ events: [] });
      }
      if (url.pathname.endsWith("/bundle")) {
        return json({
          capture: { completeness: "complete" },
          problem_statement: "Undeclared flat candidate",
          template: { "A.java": "class A {}" },
          solution: { "A.java": "class A {}" },
          tests: { "ATest.java": "class ATest {}" },
        });
      }
      return json(generationStatus("flat-run", "SUCCEEDED", "SUCCEEDED"));
    });

    const response = await new ArtemisGenerator(requestFor(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(response.status).toBe("infra_failed");
    expect(response.message).toContain("Unrecognized keys");
  });

  test("bounds cumulative generation events and removes an incomplete journal", async () => {
    const output = await fixtureDirectory();
    const { baseUrl } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          idempotent_start: true,
          artifact_bundle: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/generation/runs") {
        return json({ runId: "event-run" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        return json({
          events: [
            { sequence: 1, occurred_at: occurredAt, type: "ONE" },
            { sequence: 2, occurred_at: occurredAt, type: "TWO" },
          ],
        });
      }
      return json(generationStatus("event-run", "SUCCEEDED", "SUCCEEDED"));
    });

    const response = await new ArtemisGenerator(
      requestFor(output, baseUrl, { max_event_count: 1 }),
      output,
    ).generate(new AbortController().signal);

    expect(response.status).toBe("infra_failed");
    expect(response.message).toContain("max_event_count");
    expect(await Bun.file(join(output, "artemis", "events.jsonl")).exists()).toBe(false);
  });
});

describe("Artemis canonical verifier bridge", () => {
  test("rejects candidate paths outside the normative TextTree contract", () => {
    const request = verificationRequestFor("http://localhost");
    expect(
      artemisVerificationRequestSchema.safeParse({
        ...request,
        candidate: {
          ...request.candidate,
          template: { "src\\Answer.java": "class Answer {}" },
        },
      }).success,
    ).toBe(false);
    expect(
      artemisVerificationRequestSchema.safeParse({
        ...request,
        candidate: {
          ...request.candidate,
          solution: { "C:/Answer.java": "class Answer {}" },
        },
      }).success,
    ).toBe(false);
  });

  test("does not renew an expired verification deadline after restart", async () => {
    const output = await fixtureDirectory();
    await mkdir(join(output, "artemis-verifier"), { recursive: true });
    await writeFile(
      join(output, "artemis-verifier", "state.json"),
      JSON.stringify({
        schema_version: "2",
        attempt_id: "obs-test-1",
        run_id: "expired-run",
        started_at: "2020-01-01T00:00:00.000Z",
        deadline_at: "2020-01-01T00:00:01.000Z",
      }),
    );
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/expired-run/cancel")) {
        return new Response(null, { status: 204 });
      }
      return json({ error: "unexpected request" }, 500);
    });

    await expect(
      new ArtemisVerifier(verificationRequestFor(baseUrl), output).verify(
        new AbortController().signal,
      ),
    ).rejects.toThrow("wall-time budget");
    expect(recorded.filter((entry) => entry.path.endsWith("/expired-run/cancel"))).toHaveLength(1);
    expect(recorded.some((entry) => entry.path.endsWith("/capabilities"))).toBe(false);
  });

  test("cancels its remote run when the evaluation signal aborts", async () => {
    const output = await fixtureDirectory();
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/verification/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          canonical_candidate_verifier: true,
          idempotent_start: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/verification/runs") {
        return json({ runId: "verify-slow" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        return json({ events: [] });
      }
      if (url.pathname.endsWith("/cancel")) {
        return json({ state: "CANCELLING" }, 202);
      }
      return json(verificationStatus("verify-slow", "abort-test", "RUNNING"));
    });
    const identity = {
      id: "artemis-canonical",
      version: "1",
      revision: "verifier-revision",
      target_profile: "artemis-java-v1",
      implementation_digest: "d".repeat(64),
    };
    const request = artemisVerificationRequestSchema.parse({
      protocol_version: "1",
      attempt_id: "abort-test",
      candidate_digest: artifactDigest,
      target: {
        id: "artemis-java-maven",
        version: "1",
        revision: "target-sha",
        parameters: {},
      },
      verifier_profile: "artemis-java-v1",
      evaluator: identity,
      suite: { id: "primary", version: "1", digest: "e".repeat(64) },
      budget: { wall_time_ms: 2_000 },
      parameters: {
        base_url: baseUrl,
        auth: { type: "none" },
        poll_interval_ms: 1,
      },
      candidate: {
        problem_statement: "Return 42.",
        template: { "A.java": "class A {}" },
        solution: { "A.java": "class A {}" },
        tests: { "ATest.java": "class ATest {}" },
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("test abort")), 10);

    await expect(new ArtemisVerifier(request, output).verify(controller.signal)).rejects.toThrow();
    expect(
      recorded.some(
        (entry) =>
          entry.method === "POST" &&
          entry.path === "/api/hyperion/verification/runs/verify-slow/cancel",
      ),
    ).toBe(true);
  });

  test("recovers a verification by stable attempt ID and waits for cancellation", async () => {
    const output = await fixtureDirectory();
    let cancelled = false;
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/by-client-attempt/recover-verification")) {
        return json({ runId: "orphan-verification" });
      }
      if (url.pathname.endsWith("/orphan-verification/cancel")) {
        cancelled = true;
        return json({ state: "CANCELLING" }, 202);
      }
      if (url.pathname.endsWith("/orphan-verification")) {
        return json(
          verificationStatus(
            "orphan-verification",
            "recover-verification",
            cancelled ? "CANCELLED" : "RUNNING",
          ),
        );
      }
      return json({ error: "not found" }, 404);
    });

    await recoverArtemisVerification(
      "recover-verification",
      artemisParametersSchema.parse({
        base_url: baseUrl,
        auth: { type: "none" },
        poll_interval_ms: 1,
      }),
      output,
      new AbortController().signal,
    );

    expect(
      recorded.filter(
        (entry) =>
          entry.method === "POST" &&
          entry.path === "/api/hyperion/verification/runs/orphan-verification/cancel",
      ),
    ).toHaveLength(1);
    expect(
      recorded.some(
        (entry) => entry.method === "POST" && entry.path === "/api/hyperion/verification/runs",
      ),
    ).toBe(false);
  });

  test("rejects contradictory verification state and outcome", async () => {
    const output = await fixtureDirectory();
    const { baseUrl } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/verification/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          canonical_candidate_verifier: true,
          idempotent_start: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/verification/runs") {
        return json({ runId: "contradictory-run" }, 202);
      }
      return json(verificationStatus("contradictory-run", "obs-test-1", "PASSED", "FAILED"));
    });

    await expect(
      new ArtemisVerifier(verificationRequestFor(baseUrl), output).verify(
        new AbortController().signal,
      ),
    ).rejects.toThrow("contradict");
  });

  for (const mismatch of [
    { field: "runId", value: "another-run", expected: "different runId" },
    {
      field: "client_attempt_id",
      value: "another-attempt",
      expected: "different client_attempt_id",
    },
    {
      field: "candidate_digest",
      value: "9".repeat(64),
      expected: "different candidate digest",
    },
  ] as const) {
    test(`rejects verification evidence with a mismatched ${mismatch.field}`, async () => {
      const output = await fixtureDirectory();
      const requestHolder: { value?: ReturnType<typeof verificationRequestFor> } = {};
      const { baseUrl } = startMock((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/verification/capabilities")) {
          return json({
            protocol_version: "1",
            durable_runs: true,
            canonical_candidate_verifier: true,
            idempotent_start: true,
            sequenced_events: true,
            cancellation: true,
          });
        }
        if (url.pathname === "/api/hyperion/verification/runs") {
          return json({ runId: "bound-run" }, 202);
        }
        if (url.pathname.endsWith("/events")) {
          return json({ events: [] });
        }
        if (url.pathname.endsWith("/evidence")) {
          const verificationRequest = requestHolder.value;
          if (!verificationRequest) {
            throw new Error("test request not initialized");
          }
          return json({
            runId: "bound-run",
            client_attempt_id: "obs-test-1",
            candidate_digest: verificationRequest.candidate_digest,
            [mismatch.field]: mismatch.value,
            evaluator: verificationRequest.evaluator,
            suite: verificationRequest.suite,
            report: {},
            provenance: verificationProvenance(),
          });
        }
        return json(verificationStatus("bound-run", "obs-test-1", "COMPLETED", "PASSED"));
      });
      const verificationRequest = verificationRequestFor(baseUrl);
      requestHolder.value = verificationRequest;

      await expect(
        new ArtemisVerifier(verificationRequest, output).verify(new AbortController().signal),
      ).rejects.toThrow(mismatch.expected);
    });
  }

  for (const omission of ["report", "provenance"] as const) {
    test(`rejects verification evidence missing required ${omission}`, async () => {
      const output = await fixtureDirectory();
      const requestHolder: { value?: ReturnType<typeof verificationRequestFor> } = {};
      const { baseUrl } = startMock((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/verification/capabilities")) {
          return json({
            protocol_version: "1",
            durable_runs: true,
            canonical_candidate_verifier: true,
            idempotent_start: true,
            sequenced_events: true,
            cancellation: true,
          });
        }
        if (url.pathname === "/api/hyperion/verification/runs") {
          return json({ runId: "evidence-drift" }, 202);
        }
        if (url.pathname.endsWith("/events")) {
          return json({ events: [] });
        }
        if (url.pathname.endsWith("/evidence")) {
          const verificationRequest = requestHolder.value;
          if (!verificationRequest) {
            throw new Error("test request not initialized");
          }
          const evidence = {
            runId: "evidence-drift",
            client_attempt_id: "obs-test-1",
            candidate_digest: verificationRequest.candidate_digest,
            evaluator: verificationRequest.evaluator,
            suite: verificationRequest.suite,
            report: { mechanically_valid: true },
            provenance: verificationProvenance(),
          };
          const { [omission]: _, ...incompleteEvidence } = evidence;
          return json(incompleteEvidence);
        }
        return json(verificationStatus("evidence-drift", "obs-test-1", "COMPLETED", "PASSED"));
      });
      const verificationRequest = verificationRequestFor(baseUrl);
      requestHolder.value = verificationRequest;

      await expect(
        new ArtemisVerifier(verificationRequest, output).verify(new AbortController().signal),
      ).rejects.toThrow(omission);
    });
  }

  test("bounds cumulative verification events and removes an incomplete journal", async () => {
    const output = await fixtureDirectory();
    const { baseUrl } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/verification/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          canonical_candidate_verifier: true,
          idempotent_start: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/verification/runs") {
        return json({ runId: "event-limit" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        return json({
          events: [{ sequence: 1, occurred_at: occurredAt, type: "TOO_LARGE" }],
        });
      }
      return json(verificationStatus("event-limit", "obs-test-1", "COMPLETED", "PASSED"));
    });

    await expect(
      new ArtemisVerifier(
        verificationRequestFor(baseUrl, "obs-test-1", { max_event_bytes: 16 }),
        output,
      ).verify(new AbortController().signal),
    ).rejects.toThrow("max_event_bytes");
    expect(await Bun.file(join(output, "artemis-verifier", "events.jsonl")).exists()).toBe(false);
  });

  test("returns a structured canonical report without involving generation", async () => {
    const output = await fixtureDirectory();
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/verification/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          canonical_candidate_verifier: true,
          idempotent_start: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/verification/runs") {
        return json({ runId: "verify-1" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        const after = url.searchParams.get("after");
        return json({
          events:
            after === "0"
              ? [{ sequence: 1, occurred_at: occurredAt, type: "BUILD_PASSED" }]
              : after === "1"
                ? [{ sequence: 2, occurred_at: occurredAt, type: "VERDICT_RECORDED" }]
                : [],
        });
      }
      if (url.pathname.endsWith("/evidence")) {
        return json({
          runId: "verify-1",
          client_attempt_id: "obs-test-1",
          candidate_digest: artifactDigest,
          evaluator: {
            id: "artemis-canonical",
            version: "1",
            revision: "verifier-revision",
            target_profile: "artemis-java-v1",
            implementation_digest: "d".repeat(64),
          },
          suite: {
            id: "primary",
            version: "1",
            digest: "e".repeat(64),
          },
          report: {
            mechanically_valid: true,
            gates: [{ id: "build", status: "passed" }],
          },
          provenance: verificationProvenance(),
        });
      }
      if (url.pathname.endsWith("/verify-1")) {
        return json(verificationStatus("verify-1", "obs-test-1", "COMPLETED", "PASSED"));
      }
      return json({ error: "not found" }, 404);
    });
    const request = artemisVerificationRequestSchema.parse({
      protocol_version: "1",
      attempt_id: "obs-test-1",
      candidate_digest: artifactDigest,
      target: {
        id: "artemis-java-maven",
        version: "1",
        revision: "target-sha",
        parameters: {},
      },
      verifier_profile: "artemis-java-v1",
      evaluator: {
        id: "artemis-canonical",
        version: "1",
        revision: "verifier-revision",
        target_profile: "artemis-java-v1",
        implementation_digest: "d".repeat(64),
      },
      suite: {
        id: "primary",
        version: "1",
        digest: "e".repeat(64),
      },
      budget: { wall_time_ms: 2_000 },
      parameters: {
        base_url: baseUrl,
        auth: { type: "none" },
        poll_interval_ms: 1,
      },
      candidate: {
        problem_statement: "Return 42.",
        template: { "A.java": "class A {}" },
        solution: { "A.java": "class A {}" },
        tests: { "ATest.java": "class ATest {}" },
      },
    });

    const response = await new ArtemisVerifier(request, output).verify(
      new AbortController().signal,
    );

    expect(response.status).toBe("passed");
    expect(response.report.mechanically_valid).toBe(true);
    const start = recorded.find((entry) => entry.path === "/api/hyperion/verification/runs");
    expect(start?.headers.get("idempotency-key")).toBe("obs-test-1");
    expect(recorded.some((entry) => entry.path.includes("/generation/runs"))).toBe(false);
    expect(recorded.some((entry) => entry.path.endsWith("/events?after=2"))).toBe(true);
  });

  test("maps a canonical rejection to quality failure in the shared evaluator protocol", async () => {
    const directory = await fixtureDirectory();
    const candidateOutput = join(directory, "candidate");
    const evidenceRoot = join(directory, "evaluations");
    await Promise.all([
      mkdir(join(candidateOutput, "artifacts", "template"), { recursive: true }),
      mkdir(join(candidateOutput, "artifacts", "solution"), { recursive: true }),
      mkdir(join(candidateOutput, "artifacts", "tests"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(candidateOutput, "artifacts", "problem-statement.md"), "Return 42."),
      writeFile(join(candidateOutput, "artifacts", "template", "A.java"), "class A {}"),
      writeFile(join(candidateOutput, "artifacts", "solution", "A.java"), "class A {}"),
      writeFile(join(candidateOutput, "artifacts", "tests", "ATest.java"), "class ATest {}"),
      writeFile(
        join(candidateOutput, "response.json"),
        JSON.stringify({
          protocol_version: "1",
          status: "succeeded",
          capture: { completeness: "complete" },
          artifacts: [
            {
              role: "problem_statement",
              path: "artifacts/problem-statement.md",
            },
            { role: "template", path: "artifacts/template" },
            { role: "solution", path: "artifacts/solution" },
            { role: "tests", path: "artifacts/tests" },
          ],
          extensions: {},
        }),
      ),
    ]);
    const target = {
      id: "artemis-java-maven",
      version: "1",
      revision: "target-revision",
      parameters: {},
    };
    const candidateResponse = generationResponseSchema.parse(
      JSON.parse(await readFile(join(candidateOutput, "response.json"), "utf8")),
    );
    const artifactDigest = await validateAndDigestArtifacts(candidateResponse, candidateOutput);
    const { baseUrl } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/verification/capabilities")) {
        return json({
          protocol_version: "1",
          durable_runs: true,
          canonical_candidate_verifier: true,
          idempotent_start: true,
          sequenced_events: true,
          cancellation: true,
        });
      }
      if (url.pathname === "/api/hyperion/verification/runs") {
        return json({ runId: "verify-rejected" }, 202);
      }
      if (url.pathname.endsWith("/events")) {
        return json({ events: [] });
      }
      if (url.pathname.endsWith("/evidence")) {
        return json({
          runId: "verify-rejected",
          client_attempt_id: "a".repeat(64),
          candidate_digest: artifactDigest,
          evaluator: {
            id: "artemis-canonical",
            version: "1",
            revision: "verifier-revision",
            target_profile: "artemis-java-v1",
            implementation_digest: "d".repeat(64),
          },
          suite: {
            id: "primary",
            version: "1",
            digest: "e".repeat(64),
          },
          report: {
            failure_category: "tests.failed",
            gates: [{ id: "behavioral-tests", status: "failed" }],
          },
          provenance: verificationProvenance(),
        });
      }
      return json(verificationStatus("verify-rejected", "a".repeat(64), "FAILED"));
    });
    const evaluationRequest = evaluationRequestSchema.parse({
      protocol_version: "1",
      evaluation_id: "a".repeat(64),
      candidate: {
        experiment_id: "experiment-1",
        attempt_id: "attempt-1",
        generation_key: "b".repeat(64),
        case_id: "case-1",
        system_id: "system-1",
        replicate: 1,
        artifact_digest: artifactDigest,
        bundle_path: candidateOutput,
      },
      evaluator: {
        id: "artemis-canonical",
        version: "1",
        revision: "verifier-revision",
        target_profile: "artemis-java-v1",
        implementation_digest: "d".repeat(64),
      },
      suite: {
        id: "primary",
        version: "1",
        digest: "e".repeat(64),
      },
      requested_metrics: ["artemis.canonical_acceptance"],
      timeout_ms: 2_000,
    });
    const options = {
      parameters: {
        base_url: baseUrl,
        auth: { type: "none" },
        approach: { id: "hyperion.full", version: "1" },
        poll_interval_ms: 1,
        request_timeout_ms: 1_000,
        max_http_retries: 0,
        max_http_response_bytes: 2 * 1024 * 1024,
        max_http_total_bytes: 8 * 1024 * 1024,
        max_artifact_bytes: 1024 * 1024,
        max_event_count: 10_000,
        max_event_bytes: 16 * 1024 * 1024,
        request_extensions: {},
      },
      evidenceRoot,
      target,
    } satisfies ArtemisEvaluationOptions;
    const execute = createArtemisEvaluationExecutor(options);

    const response = await evaluateCandidateWithArtemis(
      evaluationRequest,
      {
        signal: new AbortController().signal,
      },
      options,
    );

    expect(response.status).toBe("quality_failed");
    expect(response.strict_success).toBe(false);
    expect(response.failure_category).toBe("tests.failed");
    expect(response.scores[0]?.value).toBe(false);
    expect(
      await Bun.file(
        join(evidenceRoot, "a".repeat(64), "artemis-verifier", "evidence.json"),
      ).exists(),
    ).toBe(true);

    await writeFile(
      join(candidateOutput, "artifacts", "solution", "A.java"),
      "class A { int changed; }",
    );
    const directlyMutated = await evaluateCandidateWithArtemis(
      evaluationRequest,
      { signal: new AbortController().signal },
      options,
    );
    expect(directlyMutated.status).toBe("quality_failed");
    expect(directlyMutated.failure_category).toBe("candidate.invalid");

    const mutated = await execute(evaluationRequest, {
      signal: new AbortController().signal,
    });
    expect(mutated.status).toBe("quality_failed");
    expect(mutated.failure_category).toBe("candidate.invalid");
    expect(mutated.scores[0]?.message).toContain("digest changed");
  });
});
