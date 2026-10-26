import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { implementationDigest, implementationFiles, suiteDigest } from "../tools/kit/identity.ts";
import {
  chatCompletion,
  judgeClaims,
} from "../tools/tier1-model-assisted/promise-traceability-model/model.ts";
import {
  buildModelScores,
  MODEL_ASSISTED_METRICS,
} from "../tools/tier1-model-assisted/promise-traceability-model/scores.ts";
import { evaluationRequestSchema, evaluationResponseSchema } from "../src/evaluation/contracts.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";
import { createEvaluationProcessExecutor } from "../src/evaluation/process-executor.ts";
import { metricCardsSchema } from "../src/export/metric-card.ts";

const evaluatorDirectory = resolve("tools/tier1-model-assisted/promise-traceability-model");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const STATEMENT = "The `summarise` method must never return `null`.\n";
const SUITE = "class SummariserTest { @Test void runs() { assertEquals(1, 1); } }\n";

async function writeBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "promise-traceability-model-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "artifacts", "tests"), { recursive: true });
  await writeFile(join(root, "artifacts", "problem-statement.md"), STATEMENT);
  await writeFile(join(root, "artifacts", "tests", "SummariserTest.java"), SUITE);
  await writeFile(
    join(root, "response.json"),
    JSON.stringify({
      status: "succeeded",
      artifacts: [
        { role: "problem_statement", path: "artifacts/problem-statement.md" },
        { role: "tests", path: "artifacts/tests" },
      ],
    }),
  );
  return root;
}

describe("model-assisted scores", () => {
  test("reports the claims the model extracted and judged", () => {
    const scores = buildModelScores(
      [...MODEL_ASSISTED_METRICS],
      [
        { claim: "never returns null", witnessed: false, rationale: "no assertNotNull" },
        { claim: "counts overdue events", witnessed: true, rationale: "asserted" },
      ],
    );
    expect(Object.fromEntries(scores.map((score) => [score.metric_id, score.value]))).toEqual({
      "promise.model_claims": 2,
      "promise.model_unwitnessed_claims": 1,
      "promise.model_witnessed_ratio": 0.5,
    });
  });

  test("leaves the ratio not applicable when the model extracted no claim", () => {
    const scores = buildModelScores(["promise.model_witnessed_ratio"], []);
    expect(scores[0]).toMatchObject({ status: "not_applicable" });
  });

  test("refuses a metric it does not produce instead of inventing a value", () => {
    const scores = buildModelScores(["promise.witnessed_ratio"], []);
    expect(scores[0]).toMatchObject({ status: "not_applicable" });
    expect(scores[0]?.message).toContain("not produced");
  });
});

describe("model client", () => {
  test("reads claims and verdicts out of a fenced JSON completion", async () => {
    const outcome = await judgeClaims(
      async () =>
        '```json\n{"claims":[{"claim":"never returns null","witnessed":false,"rationale":"no assertNotNull"}]}\n```',
      STATEMENT,
      SUITE,
    );
    expect(outcome).toEqual({
      status: "ok",
      claims: [{ claim: "never returns null", witnessed: false, rationale: "no assertNotNull" }],
    });
  });

  test("fails closed when the model answers with something other than the agreed shape", async () => {
    const outcome = await judgeClaims(async () => "I cannot help with that.", "statement", "suite");
    expect(outcome.status).toBe("failed");
  });

  test("asks the completions endpoint for a deterministic, bearer-authorised judgement", async () => {
    let seen: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { model: string; temperature: number };
        seen = {
          authorization: request.headers.get("authorization"),
          pathname: new URL(request.url).pathname,
          model: body.model,
          temperature: body.temperature,
        };
        return Response.json({ choices: [{ message: { content: '{"claims":[]}' } }] });
      },
    });
    try {
      const complete = chatCompletion({
        baseUrl: `${server.url.origin}/v1/`,
        model: "fixture-model",
        apiKey: "fixture-key",
        timeoutMs: 5_000,
      });
      expect(await complete("prompt")).toBe('{"claims":[]}');
      expect(seen).toEqual({
        authorization: "Bearer fixture-key",
        pathname: "/v1/chat/completions",
        model: "fixture-model",
        temperature: 0,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("reports a provider error as a failure rather than an empty claim set", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
    try {
      const outcome = await judgeClaims(
        chatCompletion({
          baseUrl: server.url.origin,
          model: "fixture-model",
          apiKey: undefined,
          timeoutMs: 5_000,
        }),
        "statement",
        "suite",
      );
      expect(outcome).toEqual({
        status: "failed",
        message: "model failed: provider responded 503",
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe("evaluator process", () => {
  const invoke = (baseUrl: string, bundlePath: string) =>
    createEvaluationProcessExecutor({
      argv: [
        process.execPath,
        "run",
        join(evaluatorDirectory, "worker.ts"),
        "--model",
        "fixture-model",
        "--base-url",
        baseUrl,
      ],
      input: (request) => request,
      responseSchema: evaluationResponseSchema,
      cwd: evaluatorDirectory,
    })(
      evaluationRequestSchema.parse({
        protocol_version: "1",
        evaluation_id: "b".repeat(64),
        candidate: {
          experiment_id: "fixture",
          attempt_id: "fixture-attempt",
          generation_key: "c".repeat(64),
          case_id: "summariser",
          system_id: "fixture-system",
          replicate: 1,
          artifact_digest: "d".repeat(64),
          capture_completeness: "complete",
          bundle_path: bundlePath,
        },
        evaluator: {
          id: "promise-traceability-model",
          version: "1",
          revision: "fixture",
          target_profile: "artemis-java-maven",
          implementation_digest: "e".repeat(64),
        },
        suite: { id: "promise-traceability-model-study", version: "1", digest: "f".repeat(64) },
        requested_metrics: [...MODEL_ASSISTED_METRICS],
        timeout_ms: 60_000,
      }),
      { signal: new AbortController().signal },
    );

  test("answers with the model's judgement as a measured response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          choices: [
            {
              message: {
                content:
                  '{"claims":[{"claim":"never returns null","witnessed":false,"rationale":"no assertNotNull"}]}',
              },
            },
          ],
        }),
    });
    try {
      const response = await invoke(server.url.origin, await writeBundle());
      expect(response.status).toBe("succeeded");
      expect(
        response.scores.find((score) => score.metric_id === "promise.model_unwitnessed_claims")
          ?.value,
      ).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("reports a model failure as an infrastructure failure, never a quality verdict", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
    try {
      const response = await invoke(server.url.origin, await writeBundle());
      expect(response.status).toBe("infra_failed");
      expect(response.strict_success).toBeNull();
      expect(response.scores.every((score) => score.status === "infra_failure")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

describe("published evaluator identity", () => {
  test("declares the current implementation and suite digests", async () => {
    const config = processEvaluatorConfigSchema.parse(
      parse(await Bun.file(join(evaluatorDirectory, "evaluator.yaml")).text()),
    );
    expect(config.evaluator.id).toBe("promise-traceability-model");
    expect(config.evaluator.implementation_digest).toBe(
      await implementationDigest(evaluatorDirectory),
    );
    expect(config.suite.digest).toBe(await suiteDigest(evaluatorDirectory));
    expect([...config.requested_metrics].sort()).toEqual([...MODEL_ASSISTED_METRICS].sort());
  });

  test("publishes an exploratory, unvalidated card for every metric it produces", async () => {
    const cards = metricCardsSchema.parse(
      await Bun.file(join(evaluatorDirectory, "metric-cards.json")).json(),
    );
    expect(Object.fromEntries(cards.metrics.map((metric) => [metric.id, metric.tier]))).toEqual(
      Object.fromEntries(MODEL_ASSISTED_METRICS.map((metric) => [metric, "exploratory"])),
    );
    expect(cards.metrics.every((metric) => metric.validation.status === "planned")).toBe(true);
  });

  test("shares no module with the deterministic tool beyond the kit and the harness", async () => {
    const files = await implementationFiles(evaluatorDirectory);
    expect(files.filter((file) => file.startsWith("tools/tier1-deterministic/"))).toEqual([]);
  });
});
