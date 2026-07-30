import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  generationRequestSchema,
  generationResponseSchema,
  type GenerationRequest,
} from "../src/contracts.ts";
import { ArtemisGenerator } from "../adapters/artemis/client.ts";
import { artemisParametersSchema } from "../adapters/artemis/config.ts";
import { ArtemisVerifier, artemisVerificationRequestSchema } from "../adapters/artemis/verifier.ts";
import { createArtemisEvaluationExecutor } from "../adapters/artemis/evaluation.ts";
import { evaluationRequestSchema } from "../src/evaluation/contracts.ts";
import { validateAndDigestArtifacts } from "../src/adapters/artifacts.ts";

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
      adapter: "artemis",
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

describe("Artemis research bridge", () => {
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
        return json({ events: [{ sequence: 1, type: "RUN_STARTED" }] });
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
          approach: { id: "external.experimental", version: "3" },
          provenance: { artemis_revision: "abc123" },
          verification: { status: "PASSED" },
        });
      }
      if (url.pathname.endsWith("/run-1")) {
        return json({
          runId: "run-1",
          state: "SUCCEEDED",
          outcome: "SUCCEEDED",
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

    expect(generationResponseSchema.parse(response).status).toBe("succeeded");
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
    expect(start?.headers.get("idempotency-key")).toBe("obs-test-1");
    expect((start?.body as { approach?: { id?: string } } | undefined)?.approach?.id).toBe(
      "external.experimental",
    );
    const evidence = JSON.parse(
      await readFile(join(output, "artemis", "research-evidence.json"), "utf8"),
    ) as { events: unknown[] };
    expect(evidence.events).toHaveLength(1);
  });

  test("retains a failed research candidate when the durable API captured it", async () => {
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
        state: "FAILED",
        outcome: "FAILED",
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
      return json({ state: "RUNNING" });
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
});

describe("Artemis legacy pilot bridge", () => {
  test("collects the exact saved version and commit trees", async () => {
    const output = await fixtureDirectory();
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (
        url.pathname === "/api/hyperion/programming-exercises/17/generate-exercise" &&
        request.method === "POST"
      ) {
        return json({ jobId: "legacy-job" }, 202);
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        return json({
          jobId: "legacy-job",
          running: false,
          events: [
            {
              type: "DONE",
              completionStatus: "NEEDS_REVIEW",
              message: "saved for review",
              savedExerciseVersionId: 91,
              savedRepositoryCommits: {
                TEMPLATE: "template-sha",
                SOLUTION: "solution-sha",
                TESTS: "tests-sha",
              },
              verdict: { mechanicalVerificationPassed: true },
            },
          ],
        });
      }
      if (url.pathname === "/api/exercise/exercises/17/versions/91") {
        return json({
          problemStatement: "# Exact statement",
          programmingData: {
            templateParticipation: { commitId: "template-sha" },
            solutionParticipation: { commitId: "solution-sha" },
            testsCommitId: "tests-sha",
          },
        });
      }
      if (url.pathname.endsWith("/files-content-commit-details")) {
        const type = url.searchParams.get("repositoryType");
        return json({ [`${type}.java`]: `// ${type}` });
      }
      return json({ error: "not found" }, 404);
    });

    const response = await new ArtemisGenerator(
      requestFor(output, baseUrl, { api_mode: "legacy-pilot", exercise_id: 17 }),
      output,
    ).generate(new AbortController().signal);

    expect(response.status).toBe("succeeded");
    expect(response.capture.completeness).toBe("complete");
    expect(response.extensions.artemis).toMatchObject({
      api_mode: "legacy-pilot",
      saved_exercise_version_id: 91,
      completion_status: "NEEDS_REVIEW",
    });
    expect(
      recorded.filter((entry) => entry.path.includes("files-content-commit-details")),
    ).toHaveLength(3);
    expect(
      recorded.some((entry) =>
        entry.path.includes("commitId=template-sha&repositoryType=TEMPLATE"),
      ),
    ).toBe(true);
  });

  test("truthfully reports no failed artifacts because the pilot API exposes none", async () => {
    const output = await fixtureDirectory();
    const { baseUrl, recorded } = startMock((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/generate-exercise") && request.method === "POST") {
        return json({ jobId: "failed-job" }, 202);
      }
      if (url.pathname.endsWith("/status")) {
        return json({
          jobId: "failed-job",
          running: false,
          events: [
            {
              type: "ERROR",
              message: "agent failed",
              terminationReason: "AGENT_ERROR",
            },
          ],
        });
      }
      return json({ error: "not found" }, 404);
    });

    const response = await new ArtemisGenerator(
      requestFor(output, baseUrl, { api_mode: "legacy-pilot", exercise_id: 18 }),
      output,
    ).generate(new AbortController().signal);

    expect(response.status).toBe("failed");
    expect(response.artifacts).toEqual([]);
    expect(response.capture).toEqual({
      completeness: "none",
      reason: "the legacy/pilot API does not expose failed candidate workspaces",
    });
    expect(recorded.some((entry) => entry.path.includes("files-content-commit-details"))).toBe(
      false,
    );
  });
});

describe("Artemis canonical verifier bridge", () => {
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
      return json({ state: "RUNNING" });
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
        api_mode: "research",
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
        return json({ events: [{ sequence: 1, type: "BUILD_PASSED" }] });
      }
      if (url.pathname.endsWith("/evidence")) {
        return json({
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
          provenance: { verifier_revision: "verifier-sha" },
        });
      }
      if (url.pathname.endsWith("/verify-1")) {
        return json({ state: "COMPLETED", outcome: "PASSED" });
      }
      return json({ error: "not found" }, 404);
    });
    const request = artemisVerificationRequestSchema.parse({
      protocol_version: "1",
      attempt_id: "obs-test-1",
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
        api_mode: "research",
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
      adapter: "artemis",
      version: "1",
      revision: "target-revision",
      parameters: {},
    };
    const candidateResponse = generationResponseSchema.parse(
      JSON.parse(await readFile(join(candidateOutput, "response.json"), "utf8")),
    );
    const artifactDigest = await validateAndDigestArtifacts(
      candidateResponse,
      candidateOutput,
      target,
    );
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
          provenance: { verifier_revision: "v1" },
        });
      }
      return json({ state: "FAILED" });
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
    const execute = createArtemisEvaluationExecutor({
      parameters: {
        base_url: baseUrl,
        api_mode: "research",
        auth: { type: "none" },
        approach: { id: "hyperion.full" },
        poll_interval_ms: 1,
        request_timeout_ms: 1_000,
        max_http_retries: 0,
        max_http_response_bytes: 2 * 1024 * 1024,
        max_artifact_bytes: 1024 * 1024,
        request_extensions: {},
      },
      evidenceRoot,
      target,
    });

    const response = await execute(evaluationRequest, {
      signal: new AbortController().signal,
    });

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
    const mutated = await execute(evaluationRequest, {
      signal: new AbortController().signal,
    });
    expect(mutated.status).toBe("quality_failed");
    expect(mutated.failure_category).toBe("candidate.invalid");
    expect(mutated.scores[0]?.message).toContain("digest changed");
  });
});
