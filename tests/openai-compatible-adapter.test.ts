import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generationRequestSchema, generationResponseSchema } from "../src/contracts.ts";
import { writeJsonAtomic } from "../src/core/files.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OpenAI-compatible generator adapter", () => {
  test("creates a canonical candidate from one provider response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer fixture-secret");
        const body = (await request.json()) as {
          model: string;
          seed: number;
          response_format: { type: string };
        };
        expect(body.model).toBe("fixture-model");
        expect(body.seed).toBe(42);
        expect(body.response_format.type).toBe("json_object");
        return Response.json({
          id: "request-1",
          model: "fixture-model-2026",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  problem_statement: "# Return 42",
                  template: { "src/Exercise.java": "class Exercise {}" },
                  solution: { "src/Exercise.java": "class Exercise { int answer(){return 42;} }" },
                  tests: { "src/ExerciseTest.java": "class ExerciseTest {}" },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    try {
      const directory = await mkdtemp(join(tmpdir(), "exgen-openai-adapter-"));
      temporaryDirectories.push(directory);
      const outputDirectory = join(directory, "output");
      const requestPath = join(directory, "request.json");
      await writeJsonAtomic(
        requestPath,
        generationRequestSchema.parse({
          protocol_version: "1",
          attempt: { id: "obs-1", replicate: 1, seed: 42 },
          case: {
            id: "return-42",
            title: "Return 42",
            brief: "Create a Java method returning 42.",
            tags: [],
          },
          target: {
            id: "artemis-java-maven",
            version: "1",
            revision: "fixture",
          },
          budget: { wall_time_ms: 30_000, max_model_calls: 1 },
          parameters: {
            base_url: `http://127.0.0.1:${server.port}/v1`,
            api_key_env: "FIXTURE_API_KEY",
            model: "fixture-model",
          },
          output_dir: outputDirectory,
        }),
      );

      const subprocess = Bun.spawn(
        [
          process.execPath,
          "run",
          resolve("adapters/openai-compatible/adapter.ts"),
          "generate",
          "--request",
          requestPath,
          "--output",
          outputDirectory,
        ],
        {
          env: { PATH: process.env.PATH ?? "", FIXTURE_API_KEY: "fixture-secret" },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(await subprocess.exited).toBe(0);
      const response = generationResponseSchema.parse(
        JSON.parse(await readFile(join(outputDirectory, "response.json"), "utf8")),
      );
      expect(response.status).toBe("succeeded");
      expect(response.usage?.model_calls).toBe(1);
      expect(response.usage?.total_tokens).toBe(30);
      expect(
        await Bun.file(join(outputDirectory, "artifacts/solution/src/Exercise.java")).text(),
      ).toContain("42");
    } finally {
      server.stop(true);
    }
  });
});
