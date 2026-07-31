#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  generatorDescriptorSchema,
  generationRequestSchema,
  generationResponseSchema,
  type GenerationResponse,
} from "../../src/contracts.ts";
import { readResponseTextBounded, writeJsonAtomic } from "../../src/core/files.ts";

const VERSION = "1";
const REVISION = "openai-compatible-v1";
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;

const parametersSchema = z
  .object({
    base_url: z.string().url(),
    api_key_env: z.string().min(1).default("OPENAI_API_KEY"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).default(0),
    max_output_tokens: z.number().int().positive().optional(),
    system_prompt: z.string().min(1).optional(),
  })
  .strict();

const candidateSchema = z
  .object({
    problem_statement: z.string().min(1),
    template: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0),
    solution: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0),
    tests: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string };
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function safeRelativePath(path: string): string {
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    /^[A-Za-z]:\//.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((component) => component === "." || component === ".." || component === "")
  ) {
    throw new Error(`model returned an unsafe file path: ${path}`);
  }
  return path;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const safePath = safeRelativePath(relativePath);
    const destination = join(root, safePath);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, contents);
  }
}

function parseCandidate(content: string): z.infer<typeof candidateSchema> {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return candidateSchema.parse(JSON.parse(withoutFence));
}

function failureResponse(message: string, extensions: Record<string, unknown>): GenerationResponse {
  return generationResponseSchema.parse({
    protocol_version: "1",
    status: "failed",
    capture: { completeness: "none", reason: message },
    artifacts: [],
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
    capture: { completeness: "none", reason: message },
    artifacts: [],
    message,
    extensions,
  });
}

if (process.argv[2] === "describe" && process.argv[3] === "--json") {
  const descriptor = generatorDescriptorSchema.parse({
    protocol_version: "1",
    kind: "generator",
    id: "openai-compatible",
    version: VERSION,
    revision: REVISION,
    runtime: {
      name: "bun",
      version: Bun.version,
      revision: Bun.revision,
    },
    capabilities: {
      targets: ["artemis-java-maven"],
      seed: "best_effort",
      failed_artifact_capture: "none",
      cancellation: true,
    },
    parameters_schema: z.toJSONSchema(parametersSchema, { target: "draft-2020-12" }),
  });
  process.stdout.write(`${JSON.stringify(descriptor)}\n`);
  process.exit(0);
}

if (process.argv[2] !== "generate") {
  throw new Error("usage: adapter.ts generate --request PATH --output DIRECTORY");
}

const request = generationRequestSchema.parse(await Bun.file(resolve(option("--request"))).json());
const outputDirectory = resolve(option("--output"));
if (request.output_dir !== outputDirectory) {
  throw new Error("request output_dir does not match --output");
}
const parameters = parametersSchema.parse(request.parameters);
const apiKey = process.env[parameters.api_key_env];
if (!apiKey) {
  throw new Error(`missing adapter credential environment variable ${parameters.api_key_env}`);
}

const endpoint = `${parameters.base_url.replace(/\/+$/, "")}/chat/completions`;
const systemPrompt =
  parameters.system_prompt ??
  `You generate complete, autograder-ready programming exercises.
Return exactly one JSON object with this shape:
{
  "problem_statement": "Markdown visible to students",
  "template": {"relative/path": "file contents"},
  "solution": {"relative/path": "file contents"},
  "tests": {"relative/path": "file contents"},
  "metadata": {}
}
Do not use Markdown code fences. Paths must be relative and must not contain '..'.
The statement, starter, solution, and tests must be mutually consistent.
The reference solution must pass. The starter must compile but fail meaningful behavioral tests.`;

let completion: ChatCompletion;
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: parameters.model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Target: ${request.target.id}\nSeed: ${request.attempt.seed}\n\n${request.case.brief}`,
        },
      ],
      temperature: parameters.temperature,
      seed: request.attempt.seed,
      max_tokens: parameters.max_output_tokens ?? request.budget.max_output_tokens,
      response_format: { type: "json_object" },
    }),
  });
  completion = JSON.parse(
    await readResponseTextBounded(response, MAXIMUM_PROVIDER_RESPONSE_BYTES),
  ) as ChatCompletion;
  if (!response.ok) {
    throw new Error(completion.error?.message ?? `provider returned HTTP ${response.status}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeJsonAtomic(
    join(outputDirectory, "response.json"),
    infrastructureFailure(message, { failure_class: "provider_transport" }),
  );
  process.exit(0);
}

try {
  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("provider response did not contain assistant content");
  }
  const candidate = parseCandidate(content);
  const artifactsDirectory = join(outputDirectory, "artifacts");
  await Promise.all([
    mkdir(join(artifactsDirectory, "template"), { recursive: true }),
    mkdir(join(artifactsDirectory, "solution"), { recursive: true }),
    mkdir(join(artifactsDirectory, "tests"), { recursive: true }),
  ]);
  await Promise.all([
    Bun.write(join(artifactsDirectory, "problem-statement.md"), candidate.problem_statement),
    writeTree(join(artifactsDirectory, "template"), candidate.template),
    writeTree(join(artifactsDirectory, "solution"), candidate.solution),
    writeTree(join(artifactsDirectory, "tests"), candidate.tests),
  ]);

  await writeJsonAtomic(
    join(outputDirectory, "response.json"),
    generationResponseSchema.parse({
      protocol_version: "1",
      status: "succeeded",
      capture: { completeness: "complete" },
      artifacts: [
        {
          role: "problem_statement",
          path: "artifacts/problem-statement.md",
          media_type: "text/markdown",
        },
        { role: "template", path: "artifacts/template" },
        { role: "solution", path: "artifacts/solution" },
        { role: "tests", path: "artifacts/tests" },
      ],
      model: {
        provider: new URL(parameters.base_url).host,
        id: completion.model ?? parameters.model,
      },
      usage: {
        input_tokens: completion.usage?.prompt_tokens,
        output_tokens: completion.usage?.completion_tokens,
        cached_input_tokens: completion.usage?.prompt_tokens_details?.cached_tokens,
        reasoning_tokens: completion.usage?.completion_tokens_details?.reasoning_tokens,
        total_tokens: completion.usage?.total_tokens,
        model_calls: 1,
      },
      execution: {
        requested_seed: request.attempt.seed,
        seed_status: "unverifiable",
        effective_parameters: {
          temperature: parameters.temperature,
          max_output_tokens: parameters.max_output_tokens ?? request.budget.max_output_tokens,
        },
        provider_request_ids: completion.id ? [completion.id] : [],
        provider_request_ids_complete: completion.id !== undefined,
      },
      extensions: {
        provider_request_id: completion.id,
        finish_reason: completion.choices?.[0]?.finish_reason,
        candidate_metadata: candidate.metadata,
        effective_parameters: {
          temperature: parameters.temperature,
          max_output_tokens: parameters.max_output_tokens ?? request.budget.max_output_tokens,
          seed: request.attempt.seed,
        },
      },
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeJsonAtomic(
    join(outputDirectory, "response.json"),
    failureResponse(message, {
      failure_class: "invalid_model_output",
      provider_request_id: completion.id,
      model: completion.model ?? parameters.model,
    }),
  );
}
