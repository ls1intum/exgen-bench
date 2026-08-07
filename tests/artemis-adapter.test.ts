import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { unzipSync, zipSync } from "fflate";
import {
  centralEntries,
  materializeRetainedCandidate,
  verifyExportedRepositoryCommits,
} from "../adapters/artemis/artifacts.ts";
import { benchmarkEnvironment, runCampaign } from "../adapters/artemis/campaign.ts";
import { ArtemisGenerator } from "../adapters/artemis/client.ts";
import { type ArtemisParameters, artemisParametersSchema } from "../adapters/artemis/config.ts";
import { cliPath, cliPositiveInteger, runArtemisAdapter } from "../adapters/artemis/entrypoint.ts";
import { observedFactors, resolveRequestedFactors } from "../adapters/artemis/factors.ts";
import { generationStatusSchema } from "../adapters/artemis/protocol.ts";
import { ownedExerciseSchema } from "../adapters/artemis/state.ts";
import { artemisTargetParametersSchema, resolveTargetFormat } from "../adapters/artemis/target.ts";
import { validateAndDigestArtifacts } from "../src/adapters/artifacts.ts";
import { validateDiagnostics } from "../src/adapters/diagnostics.ts";
import {
  type GenerationRequest,
  type GeneratorDescriptor,
  generationRequestSchema,
  generationResponseSchema,
  generatorDescriptorSchema,
} from "../src/contracts.ts";

interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

const ROLES = ["template", "solution", "tests"] as const;
type Role = (typeof ROLES)[number];

const directories: string[] = [];
const fixtures: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const encoder = new TextEncoder();
const previousEnvironment: Record<string, string | undefined> = {};

const SHORT_NAME = "exgene4042d5503e8";
const PACKAGE_NAME = "exgene4042d5503e83d32";

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    ARTEMIS_TEST_USER: "editor",
    ARTEMIS_TEST_PASSWORD: "secret",
    ARTEMIS_TEST_OPENROUTER_KEY: "test-openrouter-key",
  })) {
    previousEnvironment[name] = process.env[name];
    process.env[name] = value;
  }
  repositories = {
    template: await buildRepository("template"),
    solution: await buildRepository("solution"),
    tests: await buildRepository("tests"),
  };
  commits = {
    template: repositories.template.commit,
    solution: repositories.solution.commit,
    tests: repositories.tests.commit,
  };
});

afterAll(async () => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env.ARTEMIS_ADAPTER_TEST_OTEL_PATH;
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  // Isolate process.exitCode mutations made by in-process CLI tests.
  const leaked = process.exitCode ?? 0;
  process.exitCode = 0;
  expect(leaked, "a test leaked a non-zero process.exitCode into the runner").toBe(0);
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-artemis-production-"));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "exgen",
      GIT_AUTHOR_EMAIL: "exgen@example.invalid",
      GIT_COMMITTER_NAME: "exgen",
      GIT_COMMITTER_EMAIL: "exgen@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

interface Repository {
  zip: Uint8Array;
  commit: string;
}

let repositories: Record<Role, Repository>;
let commits: Record<Role, string>;

async function buildRepository(role: Role): Promise<Repository> {
  const directory = await mkdtemp(join(tmpdir(), `exgen-artemis-repo-${role}-`));
  fixtures.push(directory);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", `${role}.java`), `class ${role} {}\n`);
  await git(directory, ["init", "-q", "-b", "main"]);
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-q", "-m", role]);
  const commit = await git(directory, ["rev-parse", "HEAD"]);
  const files: Record<string, Uint8Array> = {};
  for await (const relative of new Bun.Glob("**/*").scan({
    cwd: directory,
    onlyFiles: true,
    dot: true,
  })) {
    files[relative] = new Uint8Array(await Bun.file(join(directory, relative)).arrayBuffer());
  }
  return { zip: zipSync(files), commit };
}

async function extractInto(root: string, zip: Uint8Array): Promise<void> {
  for (const [path, contents] of Object.entries(unzipSync(zip))) {
    if (path.endsWith("/")) continue;
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}

function mockServer(handler: (request: Request) => Response | Promise<Response>) {
  const recorded: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: unknown;
      if (request.method === "POST" && request.headers.get("content-type")?.includes("json")) {
        body = JSON.parse(await request.text());
      }
      recorded.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: new Headers(request.headers),
        body,
      });
      return handler(request);
    },
  });
  servers.push(server);
  return { baseUrl: server.url.origin, recorded };
}

function json(value: unknown, status = 200, headers?: Headers | Record<string, string>): Response {
  return Response.json(value, { status, ...(headers ? { headers } : {}) });
}

function request(
  output: string,
  baseUrl: string,
  overrides: Record<string, unknown> = {},
  budget: Record<string, unknown> = {},
  format: Record<string, unknown> = {},
): GenerationRequest {
  const parsed = generationRequestSchema.parse({
    protocol_version: "2",
    attempt: { id: "temperature-case-system-a-r1", replicate: 1, seed: 42 },
    case: {
      id: "temperature-alert",
      title: "Temperature Alert Classification",
      brief: "Create a Java exercise that classifies temperature alerts.",
      tags: ["java"],
    },
    target: {
      id: "artemis-programming-exercise",
      version: "1",
      revision: "test",
      parameters: { language: "java", build_system: "maven" },
    },
    factors: {},
    budget: { wall_time_ms: 30_000, ...budget },
    parameters: {
      base_url: baseUrl,
      auth: {
        type: "password",
        username_env: "ARTEMIS_TEST_USER",
        password_env: "ARTEMIS_TEST_PASSWORD",
      },
      course_id: 123,
      poll_interval_ms: 1,
      max_http_retries: 0,
      accounting_settle_ms: 25,
      post_cancel_budget_ms: 2_000,
      ...overrides,
    },
    output_dir: output,
  });
  // Artemis validates format fields beyond the harness's common target schema.
  if (Object.keys(format).length === 0) return parsed;
  return {
    ...parsed,
    target: { ...parsed.target, parameters: { ...parsed.target.parameters, ...format } },
  } as GenerationRequest;
}

const started = { type: "STARTED", message: "Started", timestamp: "2026-07-31T10:00:00Z" };

function withFactors(
  base: GenerationRequest,
  factors: Record<string, string | number | boolean>,
): GenerationRequest {
  return { ...base, factors };
}

function terminalDone(overrides: Record<string, unknown> = {}) {
  return {
    type: "DONE",
    message: "Generation finished",
    completionStatus: "SUCCESS",
    verdict: { mechanicallyVerified: true },
    liveExerciseChanged: true,
    savedRepositoryCommits: commits,
    savedExerciseVersionId: 77,
    terminationReason: "CONVERGED",
    timestamp: "2026-07-31T10:01:00Z",
    ...overrides,
  };
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
    modelCalls: 3,
    toolCalls: 7,
    agentTurns: 9,
    attempts: 2,
    inputTokens: 1200,
    outputTokens: 340,
    cachedInputTokens: 900,
    cachedInputTokensComplete: true,
    estimatedCostEur: 0.42,
    estimatedCostEurComplete: true,
    models: ["gpt-oss:120b"],
    providerRequestIds: ["response-1", "response-2", "response-3"],
    providerRequestIdsComplete: true,
    ...overrides,
  };
}

interface ModelCall {
  responseId: string;
  input: number;
  output: number;
  toolCalls?: number;
}

const SINGLE_CALL: ModelCall[] = [{ responseId: "response-1", input: 100, output: 20 }];

function telemetryExport(jobId: string, calls: ModelCall[] = SINGLE_CALL): string {
  const traceId = "1".repeat(32);
  const rootId = "a".repeat(16);
  const span = (spanId: string, name: string, attributes: unknown[], parentSpanId?: string) => ({
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes,
  });
  const modelSpan = (call: ModelCall, index: number) =>
    span(
      `${index + 1}`.repeat(16).slice(0, 16),
      "chat model",
      [
        { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
        { key: "gen_ai.response.id", value: { stringValue: call.responseId } },
        {
          key: "gen_ai.input.messages",
          value: {
            stringValue: JSON.stringify([
              { role: "user", parts: [{ type: "text", content: "input" }] },
            ]),
          },
        },
        {
          key: "gen_ai.output.messages",
          value: {
            stringValue: JSON.stringify([
              {
                role: "assistant",
                parts: Array.from({ length: call.toolCalls ?? 1 }, (_, part) => ({
                  type: "tool_call",
                  id: `call-${index + 1}-${part + 1}`,
                  name: "write_file",
                  arguments: {},
                })),
                finish_reason: "TOOL_CALLS",
              },
            ]),
          },
        },
        { key: "gen_ai.usage.input_tokens", value: { stringValue: String(call.input) } },
        { key: "gen_ai.usage.output_tokens", value: { stringValue: String(call.output) } },
      ],
      rootId,
    );
  return `${JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              span(rootId, "exercise generation", [
                { key: "artemis.hyperion.job.id", value: { stringValue: jobId } },
              ]),
              ...calls.map(modelSpan),
            ],
          },
        ],
      },
    ],
  })}\n`;
}

function exactVersion(testCommit?: string, packageName = PACKAGE_NAME) {
  return {
    id: 44,
    title: "Temperature Alert Classification",
    shortName: SHORT_NAME,
    problemStatement: "# Temperature Alert Classification\n\nImplement the classifier.",
    programmingData: {
      packageName,
      templateParticipation: { id: 1, commitId: commits.template },
      solutionParticipation: { id: 2, commitId: commits.solution },
      testsCommitId: testCommit ?? commits.tests,
    },
  };
}

function productionHandler(
  options: {
    unsafeTemplate?: boolean;
    testCommit?: string;
    accountingState?: "PENDING" | "COMPLETE" | "INCOMPLETE";
    costComplete?: boolean;
    terminal?: Record<string, unknown>;
    setupShortName?: string;
    listed?: Array<Record<string, unknown>>;
    generationStarted?: boolean;
    packageName?: string;
    effortProfile?: string;
    profiles?: Array<Record<string, unknown>>;
  } = {},
) {
  let created = false;
  let generationStarted = options.generationStarted ?? false;
  return (incoming: Request): Response => {
    const url = new URL(incoming.url);
    if (url.pathname === "/api/core/public/authenticate") {
      return json({ access_token: "do-not-use-body-token" }, 200, {
        "set-cookie": "jwt=cookie-token; Path=/; HttpOnly; SameSite=Lax",
      });
    }
    if (url.pathname === "/api/programming/courses/123/programming-exercises") {
      return json(options.listed ?? (created ? [{ id: 44, shortName: "exgenother" }] : []));
    }
    if (
      url.pathname === "/api/programming/programming-exercises/setup" &&
      url.search === "?emptyRepositories=true"
    ) {
      created = true;
      return json(
        {
          id: 44,
          title: "Temperature Alert Classification",
          shortName: options.setupShortName ?? SHORT_NAME,
          packageName: options.packageName ?? PACKAGE_NAME,
        },
        201,
      );
    }
    if (url.pathname === "/api/hyperion/programming-exercises/generation/effort-profiles") {
      return json(
        options.profiles ?? [
          { name: "draft", label: "Quick draft" },
          { name: "standard", label: "Standard" },
        ],
      );
    }
    if (url.pathname === "/api/hyperion/programming-exercises/44/generate-exercise/status") {
      if (!generationStarted) return new Response(null, { status: 204 });
      return json({
        jobId: "job-1",
        running: false,
        mode: "GENERATE",
        events: [started, options.terminal ?? terminalDone()],
        fileChanges: [],
        ownedByCaller: true,
        usage: usage({ estimatedCostEurComplete: options.costComplete ?? true }),
        accountingState: options.accountingState ?? "COMPLETE",
        effortProfile: options.effortProfile ?? "standard",
      });
    }
    if (url.pathname === "/api/hyperion/programming-exercises/44/generate-exercise") {
      generationStarted = true;
      return json({ jobId: "job-1" }, 202);
    }
    if (url.pathname === "/api/exercise/exercises/44/versions/77")
      return json(exactVersion(options.testCommit, options.packageName));
    const exportMatch = url.pathname.match(
      /export-instructor-repository\/(TEMPLATE|SOLUTION|TESTS)$/,
    );
    const exportRole = exportMatch?.[1];
    if (exportRole) {
      const role = exportRole.toLowerCase() as Role;
      const bytes =
        options.unsafeTemplate && role === "template"
          ? zipSync({ "../escape.java": encoder.encode("class escape {}") })
          : repositories[role].zip;
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return json({ error: `unexpected ${incoming.method} ${url.pathname}${url.search}` }, 500);
  };
}

async function writeState(output: string, state: Record<string, unknown>): Promise<void> {
  await mkdir(join(output, "artemis"), { recursive: true });
  await writeFile(join(output, "artemis", "adapter-state.json"), JSON.stringify(state));
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(run: (argv: string[]) => Promise<void>, args: string[]): Promise<CliResult> {
  // Bun ignores `process.exitCode = undefined`, so both the reset and the restore need a number.
  const previousExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  let stderr = "";
  try {
    await run(["bun", "adapters/artemis/cli.ts", ...args]);
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
  } finally {
    process.stdout.write = write;
  }
  const exitCode = stderr.length > 0 ? 1 : (process.exitCode ?? 0);
  process.exitCode = previousExitCode;
  return { exitCode, stdout: chunks.join(""), stderr };
}

const DESCRIPTOR: Pick<GeneratorDescriptor, "id" | "revision" | "capabilities"> = {
  id: "artemis",
  revision: "artemis-production-api-v3-otel",
  capabilities: {
    targets: ["artemis-programming-exercise", "artemis-java-maven"],
    seed: "unsupported",
    failed_artifact_capture: "partial",
    cancellation: true,
    crash_recovery: "cancel",
    budget_dimensions: ["wall_time_ms"],
    controls: ["effort_profile"],
    observes: ["effort_profile"],
  },
};

function runAdapterCli(args: string[]): Promise<CliResult> {
  return runCli((argv) => runArtemisAdapter(DESCRIPTOR, argv), args);
}

function runCampaignCli(args: string[]): Promise<CliResult> {
  return runCli(runCampaign, args);
}

function bodyOf(entry: RecordedRequest | undefined): Record<string, unknown> {
  if (!entry || typeof entry.body !== "object" || entry.body === null)
    throw new Error("recorded request does not carry a JSON object body");
  return entry.body as Record<string, unknown>;
}

function startedGeneration(recorded: RecordedRequest[]): RecordedRequest[] {
  return recorded.filter(
    (entry) => entry.method === "POST" && entry.path.endsWith("/generate-exercise"),
  );
}

function mutations(recorded: RecordedRequest[]): RecordedRequest[] {
  return recorded.filter(
    (entry) => entry.method !== "GET" && entry.path !== "/api/core/public/authenticate",
  );
}

describe("Artemis production API adapter", () => {
  test("authenticates, generates, captures the exact version, and exports complete repositories", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(productionHandler());
    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(result.capture.completeness).toBe("complete");
    expect(result.extensions.artemis).toMatchObject({
      exercise_id: 44,
      job_id: "job-1",
      exact_exercise_version_id: 77,
      completion_status: "SUCCESS",
      usage_accounting_complete: true,
    });
    expect(result.usage).toEqual({
      model_calls: 3,
      tool_calls: 7,
      input_tokens: 1200,
      output_tokens: 340,
      cached_input_tokens: 900,
      total_tokens: 1540,
    });
    expect(result.cost).toEqual({ amount: 0.42, currency: "EUR" });
    expect(result.execution).toMatchObject({
      provider_request_ids: ["response-1", "response-2", "response-3"],
      provider_request_ids_complete: true,
    });
    await expect(validateAndDigestArtifacts(result, output)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
    expect(await readFile(join(output, "artifacts", "problem-statement.md"), "utf8")).toContain(
      "Temperature Alert",
    );
    expect(
      await readFile(join(output, "artifacts", "template", "src", "template.java"), "utf8"),
    ).toContain("class template");

    const auth = recorded.find((entry) => entry.path === "/api/core/public/authenticate");
    expect(auth?.body).toEqual({ username: "editor", password: "secret", rememberMe: false });
    expect(auth?.headers.get("user-agent")).toBe("exgen-bench-artemis-adapter");
    const authenticated = recorded.filter(
      (entry) => entry.path !== "/api/core/public/authenticate",
    );
    expect(authenticated.every((entry) => entry.headers.get("cookie") === "jwt=cookie-token")).toBe(
      true,
    );
    expect(authenticated.every((entry) => entry.headers.get("authorization") === null)).toBe(true);

    const setup = recorded.find((entry) => entry.path.endsWith("/setup?emptyRepositories=true"));
    expect(setup?.body).toMatchObject({
      title: `Temperature Alert Classification ${SHORT_NAME}`,
      shortName: SHORT_NAME,
      packageName: PACKAGE_NAME,
      course: { id: 123 },
      programmingLanguage: "JAVA",
      projectType: "PLAIN_MAVEN",
      problemStatement: "",
    });
    const releaseDate = bodyOf(setup).releaseDate;
    expect(typeof releaseDate).toBe("string");
    expect(Date.parse(String(releaseDate))).toBeGreaterThan(Date.now());
    expect(startedGeneration(recorded)[0]?.body).toEqual({
      mode: "GENERATE",
      prompt: "Create a Java exercise that classifies temperature alerts.",
    });
    expect(recorded.some((entry) => entry.path === "/api/exercise/exercises/44/versions/77")).toBe(
      true,
    );
    expect(
      recorded.filter((entry) => entry.path.includes("export-instructor-repository/")),
    ).toHaveLength(3);
  });

  test("reconciles Artemis accounting against exact OpenRouter billing records", async () => {
    const output = await outputDirectory();
    const artemis = mockServer(productionHandler({ costComplete: false }));
    const provider = mockServer((incoming) => {
      const url = new URL(incoming.url);
      const id = url.searchParams.get("id");
      const index =
        id === "response-1" ? 0 : id === "response-2" ? 1 : id === "response-3" ? 2 : -1;
      if (url.pathname !== "/generation" || index < 0) return json({ error: "unexpected" }, 404);
      return json({
        data: {
          id,
          model: "openai/gpt-oss-120b",
          provider_name: "fixture-provider",
          total_cost: [0.01, 0.02, 0.03][index],
          native_tokens_prompt: 400,
          native_tokens_completion: [100, 100, 140][index],
          native_tokens_cached: 300,
          native_tokens_reasoning: [20, 25, 30][index],
        },
      });
    });

    const result = await new ArtemisGenerator(
      request(output, artemis.baseUrl, {
        cost_reconciliation: {
          provider: "openrouter",
          api_key_env: "ARTEMIS_TEST_OPENROUTER_KEY",
          base_url: provider.baseUrl,
          currency: "USD",
        },
      }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("succeeded");
    expect(result.cost).toEqual({ amount: 0.06, currency: "USD" });
    expect(result.usage?.reasoning_tokens).toBe(75);
    expect(result.diagnostics?.map((diagnostic) => diagnostic.id)).toContain(
      "openrouter-cost-reconciliation",
    );
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
    expect(
      provider.recorded.every(
        (entry) => entry.headers.get("authorization") === "Bearer test-openrouter-key",
      ),
    ).toBe(true);
    expect(provider.recorded).toHaveLength(3);
  });

  test("rejects an instructor ZIP with path traversal without writing outside artifacts", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler({ unsafeTemplate: true }));
    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );
    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("unsafe archive path");
    // The entry escapes artifacts/template, so artifacts/ is where it would land.
    expect(await Bun.file(join(output, "artifacts", "escape.java")).exists()).toBe(false);
  });

  test("rejects repository identities that do not match the exact saved exercise version", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(productionHandler({ testCommit: "d".repeat(40) }));
    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );
    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("commit identities");
    expect(recorded.some((entry) => entry.path.includes("export-instructor-repository"))).toBe(
      false,
    );
  });

  test("does not claim usage or cost when Artemis accounting never completes", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler({ accountingState: "PENDING" }));
    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(result.usage).toBeUndefined();
    expect(result.cost).toBeUndefined();
    expect(result.extensions.artemis).toMatchObject({
      usage_accounting_complete: false,
      usage_accounting_gap: expect.stringContaining("accounting_settle_ms"),
    });
  });

  test("keeps polling for the accounting that Artemis publishes after the terminal event", async () => {
    const output = await outputDirectory();
    let polls = 0;
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise/status")) {
        polls += 1;
        const settled = polls >= 3;
        return json({
          jobId: "job-1",
          running: false,
          mode: "GENERATE",
          events: [started, terminalDone({ type: "ERROR", completionStatus: undefined })],
          fileChanges: [],
          ownedByCaller: true,
          ...(settled
            ? { usage: usage(), accountingState: "COMPLETE" as const }
            : { accountingState: "PENDING" as const }),
        });
      }
      if (url.pathname.endsWith("/generate-exercise")) return json({ jobId: "job-1" }, 202);
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { accounting_settle_ms: 5_000 }),
      output,
    ).generate(new AbortController().signal);

    expect(polls).toBeGreaterThanOrEqual(3);
    expect(result.status).toBe("failed");
    expect(result.extensions.artemis).toMatchObject({ usage_accounting_complete: true });
    expect(result.usage).toMatchObject({ model_calls: 3, input_tokens: 1200 });
  });

  test("records a partial Artemis persist as a generation outcome, not an adapter failure", async () => {
    const output = await outputDirectory();
    const terminal = {
      type: "DONE",
      message: "Saving did not complete; manual review is required.",
      completionStatus: "PARTIAL",
      liveExerciseChanged: true,
      savedRepositoryCommits: commits,
      terminationReason: "SAVE_INTERRUPTED",
      timestamp: "2026-07-31T10:01:00Z",
    };
    const { baseUrl, recorded } = mockServer(productionHandler({ terminal }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.capture.completeness).toBe("partial");
    expect(result.message).toContain("manual review");
    expect(result.extensions.artemis).toMatchObject({
      failure_class: "generation",
      completion_status: "PARTIAL",
      termination_reason: "SAVE_INTERRUPTED",
      usage_accounting_complete: true,
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
      "artemis-terminal-status",
    );
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
    expect(recorded.some((entry) => entry.path.includes("export-instructor-repository"))).toBe(
      false,
    );
  });

  test("preserves complete usage for a failed terminal generation", async () => {
    const output = await outputDirectory();
    const terminal = {
      type: "ERROR",
      message: "Provider failed after admitted work",
      terminationReason: "RUN_FAILED",
      timestamp: "2026-07-31T10:01:00Z",
    };
    const { baseUrl } = mockServer(productionHandler({ terminal, costComplete: false }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.capture.completeness).toBe("none");
    expect(result.usage).toMatchObject({ model_calls: 3, input_tokens: 1200, output_tokens: 340 });
    expect(result.cost).toBeUndefined();
    expect(result.execution?.provider_request_ids).toEqual([
      "response-1",
      "response-2",
      "response-3",
    ]);
    expect(result.extensions.artemis).toMatchObject({ usage_accounting_complete: true });
  });

  test("waits for terminal cancellation accounting instead of racing the status update", async () => {
    const output = await outputDirectory();
    const tracesPath = join(output, "collector-traces.jsonl");
    await writeFile(tracesPath, "");
    process.env.ARTEMIS_ADAPTER_TEST_OTEL_PATH = tracesPath;
    const controller = new AbortController();
    let created = false;
    let startedGenerationFlag = false;
    let cancelled = false;
    let postCancelPolls = 0;
    const { baseUrl } = mockServer(async (incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=cancel-token; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises")
        return json(created ? [{ id: 44, shortName: "exgenother" }] : []);
      if (
        url.pathname === "/api/programming/programming-exercises/setup" &&
        url.search === "?emptyRepositories=true"
      ) {
        created = true;
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (!startedGenerationFlag) return new Response(null, { status: 204 });
        if (cancelled) postCancelPolls += 1;
        const terminal = cancelled && postCancelPolls >= 2;
        if (terminal) await writeFile(tracesPath, telemetryExport("job-1"));
        return json({
          jobId: "job-1",
          running: !terminal,
          mode: "GENERATE",
          events: terminal
            ? [
                started,
                { type: "CANCELLED", message: "Cancelled", timestamp: "2026-07-31T10:01:00Z" },
              ]
            : [started],
          fileChanges: [],
          ownedByCaller: true,
          ...(terminal
            ? {
                usage: {
                  modelCalls: 1,
                  toolCalls: 1,
                  inputTokens: 100,
                  outputTokens: 20,
                  cachedInputTokens: 0,
                  cachedInputTokensComplete: true,
                  estimatedCostEur: 0.01,
                  estimatedCostEurComplete: true,
                  models: ["model"],
                  providerRequestIds: ["response-1"],
                  providerRequestIdsComplete: true,
                },
                accountingState: "COMPLETE" as const,
              }
            : { accountingState: "PENDING" as const }),
        });
      }
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        startedGenerationFlag = true;
        setTimeout(() => controller.abort(new Error("test cancellation")), 5);
        return json({ jobId: "job-1" }, 202);
      }
      if (url.pathname.endsWith("/jobs/job-1") && incoming.method === "DELETE") {
        cancelled = true;
        return new Response(null, { status: 200 });
      }
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, {
        request_timeout_ms: 1_000,
        server_limits: { max_turns: 60 },
        telemetry: {
          provider: "opentelemetry",
          traces_path_env: "ARTEMIS_ADAPTER_TEST_OTEL_PATH",
          artemis_otlp_endpoint: "http://127.0.0.1:4318/v1/traces",
          content_capture: "required",
          timeout_ms: 1_000,
          poll_interval_ms: 1,
          verify_usage: true,
        },
      }),
      output,
    ).generate(controller.signal);

    expect(result.status).toBe("failed");
    expect(result.message).toContain("cancelled");
    expect(result.usage).toMatchObject({
      model_calls: 1,
      tool_calls: 1,
      input_tokens: 100,
      output_tokens: 20,
    });
    expect(result.cost).toEqual({ amount: 0.01, currency: "EUR" });
    expect(result.extensions.artemis).toMatchObject({
      cost_reconciliation_configured: false,
      cost_verified: false,
      effective_limits: expect.arrayContaining([
        { id: "max_turns", source: "system_configured", value: 60 },
      ]),
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
      "artemis-opentelemetry-trace",
    );
    expect(postCancelPolls).toBeGreaterThanOrEqual(2);
  });

  function verifyingTelemetry(timeoutMs = 60) {
    return {
      provider: "opentelemetry",
      traces_path_env: "ARTEMIS_ADAPTER_TEST_OTEL_PATH",
      artemis_otlp_endpoint: "http://127.0.0.1:4318/v1/traces",
      content_capture: "required",
      timeout_ms: timeoutMs,
      poll_interval_ms: 1,
      verify_usage: true,
    };
  }

  async function emptyTraces(output: string): Promise<void> {
    const tracesPath = join(output, "collector-traces.jsonl");
    await writeFile(tracesPath, "");
    process.env.ARTEMIS_ADAPTER_TEST_OTEL_PATH = tracesPath;
  }

  test("a Hyperion failure stays failed when telemetry capture breaks, with evidence on disk", async () => {
    const output = await outputDirectory();
    await emptyTraces(output);
    const terminal = {
      type: "ERROR",
      message: "The agent loop ended with an error.",
      terminationReason: "AGENT_ERROR",
      timestamp: "2026-07-31T10:01:00Z",
    };
    const { baseUrl } = mockServer(productionHandler({ terminal }));

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { telemetry: verifyingTelemetry() }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.extensions.artemis).toMatchObject({
      failure_class: "generation",
      termination_reason: "AGENT_ERROR",
      measurement: { outcome: "trace_unavailable" },
    });
    const measurement = (result.extensions.artemis as { measurement: { reason: string } })
      .measurement;
    expect(measurement.reason).toContain("OpenTelemetry");
    expect(result.message).toBe("The agent loop ended with an error.");
    expect(result.message).not.toContain("OpenTelemetry");
    expect(await Bun.file(join(output, "artemis", "terminal-status.json")).exists()).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
      "artemis-terminal-status",
    );
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
  });

  test("a Hyperion success with broken telemetry is infra_failed but keeps the exported candidate", async () => {
    const output = await outputDirectory();
    await emptyTraces(output);
    const { baseUrl } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { telemetry: verifyingTelemetry() }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.extensions.artemis).toMatchObject({
      measurement: { outcome: "trace_unavailable" },
      exact_exercise_version_id: 77,
    });
    expect(result.capture.completeness).toBe("complete");
    expect(result.artifacts.map((artifact) => artifact.role).sort()).toEqual([
      "problem_statement",
      "solution",
      "template",
      "tests",
    ]);
    expect(
      await readFile(join(output, "artifacts", "template", "src", "template.java"), "utf8"),
    ).toContain("class template");
    expect(await Bun.file(join(output, "artemis", "terminal-status.json")).exists()).toBe(true);
    expect(await Bun.file(join(output, "artemis", "generation-evidence.json")).exists()).toBe(true);
    await expect(validateAndDigestArtifacts(result, output)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
  });

  test("a trace that contradicts Artemis accounting fails closed but keeps the candidate", async () => {
    const output = await outputDirectory();
    await emptyTraces(output);
    const tracesPath = join(output, "collector-traces.jsonl");
    const handler = productionHandler();
    const { baseUrl } = mockServer(async (incoming) => {
      const reply = handler(incoming);
      if (
        new URL(incoming.url).pathname.endsWith("/generate-exercise") &&
        incoming.method === "POST"
      )
        await writeFile(tracesPath, telemetryExport("job-1"));
      return reply;
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { telemetry: verifyingTelemetry(2_000) }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.extensions.artemis).toMatchObject({ measurement: { outcome: "disagreed" } });
    const measurement = (result.extensions.artemis as { measurement: { reason: string } })
      .measurement;
    expect(measurement.reason).toContain("contradicts Artemis accounting");
    expect(result.artifacts).not.toHaveLength(0);
    expect(await Bun.file(join(output, "artemis", "terminal-status.json")).exists()).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
      "artemis-opentelemetry-trace",
    );
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
  });

  test("succeeds with provider cost reconciliation and telemetry usage verification both on", async () => {
    const output = await outputDirectory();
    await emptyTraces(output);
    const tracesPath = join(output, "collector-traces.jsonl");
    const calls: ModelCall[] = [
      { responseId: "response-1", input: 400, output: 100, toolCalls: 3 },
      { responseId: "response-2", input: 400, output: 100, toolCalls: 2 },
      { responseId: "response-3", input: 400, output: 140, toolCalls: 2 },
    ];
    const handler = productionHandler();
    const artemis = mockServer(async (incoming) => {
      const reply = handler(incoming);
      if (
        new URL(incoming.url).pathname.endsWith("/generate-exercise") &&
        incoming.method === "POST"
      )
        await writeFile(tracesPath, telemetryExport("job-1", calls));
      return reply;
    });
    const provider = mockServer((incoming) => {
      const id = new URL(incoming.url).searchParams.get("id") ?? "";
      const index = calls.findIndex((call) => call.responseId === id);
      if (index < 0) return json({ error: "unexpected" }, 404);
      const call = calls[index];
      if (!call) return json({ error: "unexpected" }, 404);
      return json({
        data: {
          id,
          model: "openai/gpt-oss-120b",
          provider_name: "fixture-provider",
          total_cost: 0.01,
          native_tokens_prompt: call.input,
          native_tokens_completion: call.output,
          native_tokens_cached: 300,
          native_tokens_reasoning: 25,
        },
      });
    });

    const result = await new ArtemisGenerator(
      request(output, artemis.baseUrl, {
        cost_reconciliation: {
          provider: "openrouter",
          api_key_env: "ARTEMIS_TEST_OPENROUTER_KEY",
          base_url: provider.baseUrl,
          currency: "USD",
        },
        telemetry: verifyingTelemetry(4_000),
      }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("succeeded");
    expect(result.extensions.artemis).toMatchObject({
      measurement: { outcome: "captured" },
      cost_verified: true,
    });
    expect(result.cost).toEqual({ amount: 0.03, currency: "USD" });
    expect(result.usage).toMatchObject({
      model_calls: 3,
      input_tokens: 1200,
      output_tokens: 340,
      cached_input_tokens: 900,
      reasoning_tokens: 75,
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toEqual(
      expect.arrayContaining(["openrouter-cost-reconciliation", "artemis-opentelemetry-trace"]),
    );
    await expect(validateAndDigestArtifacts(result, output)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
  });

  test("publishes no cost when provider reconciliation fails, but keeps Artemis token counts", async () => {
    const output = await outputDirectory();
    const artemis = mockServer(productionHandler());
    const provider = mockServer(() => json({ error: { code: 502, message: "bad gateway" } }, 502));

    const result = await new ArtemisGenerator(
      request(output, artemis.baseUrl, {
        cost_reconciliation: {
          provider: "openrouter",
          api_key_env: "ARTEMIS_TEST_OPENROUTER_KEY",
          base_url: provider.baseUrl,
          currency: "USD",
          indexing_timeout_ms: 50,
        },
      }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.cost).toBeUndefined();
    expect(result.usage).toMatchObject({ model_calls: 3, input_tokens: 1200, output_tokens: 340 });
    expect(result.extensions.artemis).toMatchObject({
      cost_reconciliation_configured: true,
      cost_verified: false,
      measurement: { outcome: "cost_unverifiable" },
    });
    expect(result.artifacts).not.toHaveLength(0);
    expect(await Bun.file(join(output, "artemis", "terminal-status.json")).exists()).toBe(true);
  });

  test("reports cost as unverified when no reconciliation was configured", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("succeeded");
    expect(result.cost).toEqual({ amount: 0.42, currency: "EUR" });
    expect(result.extensions.artemis).toMatchObject({
      cost_reconciliation_configured: false,
      cost_verified: false,
    });
  });

  test("does not disable usage verification when Artemis cannot account for its own usage", async () => {
    const output = await outputDirectory();
    await emptyTraces(output);
    const tracesPath = join(output, "collector-traces.jsonl");
    const handler = productionHandler({ accountingState: "PENDING" });
    const { baseUrl } = mockServer(async (incoming) => {
      const reply = handler(incoming);
      if (
        new URL(incoming.url).pathname.endsWith("/generate-exercise") &&
        incoming.method === "POST"
      )
        await writeFile(tracesPath, telemetryExport("job-1"));
      return reply;
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { telemetry: verifyingTelemetry(2_000) }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.extensions.artemis).toMatchObject({
      measurement: { outcome: "product_accounting_incomplete" },
      usage_accounting_complete: false,
    });
    expect(result.usage).toBeUndefined();
    expect(result.artifacts).not.toHaveLength(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
      "artemis-opentelemetry-trace",
    );
    expect(await Bun.file(join(output, "artemis", "terminal-status.json")).exists()).toBe(true);
    await expect(validateDiagnostics(result, output)).resolves.toBeUndefined();
  });

  test("classifies an unaccounted Hyperion failure as a failure to verify, not as missingness", async () => {
    const output = await outputDirectory();
    await emptyTraces(output);
    const tracesPath = join(output, "collector-traces.jsonl");
    const terminal = {
      type: "ERROR",
      message: "The agent loop ended with an error.",
      terminationReason: "AGENT_ERROR",
      timestamp: "2026-07-31T10:01:00Z",
    };
    const handler = productionHandler({ terminal, accountingState: "PENDING" });
    const { baseUrl } = mockServer(async (incoming) => {
      const reply = handler(incoming);
      if (
        new URL(incoming.url).pathname.endsWith("/generate-exercise") &&
        incoming.method === "POST"
      )
        await writeFile(tracesPath, telemetryExport("job-1"));
      return reply;
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { telemetry: verifyingTelemetry(2_000) }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.extensions.artemis).toMatchObject({
      termination_reason: "AGENT_ERROR",
      measurement: {
        outcome: "product_accounting_incomplete",
        reason: expect.stringContaining("accounting_settle_ms"),
      },
    });
  });

  test("names the accounting gap when an attempt breaks before Artemis ever accounts", async () => {
    const output = await outputDirectory();
    await emptyTraces(output);
    const tracesPath = join(output, "collector-traces.jsonl");
    let generationStarted = false;
    const { baseUrl } = mockServer(async (incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        generationStarted = true;
        await writeFile(tracesPath, telemetryExport("job-1"));
        return json({ jobId: "job-1" }, 202);
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (!generationStarted) return new Response(null, { status: 204 });
        return json({
          jobId: "job-other",
          running: true,
          mode: "GENERATE",
          events: [started],
          fileChanges: [],
          ownedByCaller: false,
          accountingState: "PENDING",
        });
      }
      if (incoming.method === "DELETE") return new Response(null, { status: 200 });
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { telemetry: verifyingTelemetry(2_000) }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.extensions.artemis).toMatchObject({
      usage_accounting_complete: false,
      measurement: {
        outcome: "product_accounting_incomplete",
        reason: expect.stringContaining("accounting_settle_ms"),
      },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toContain(
      "artemis-opentelemetry-trace",
    );
  });

  test("recovery cancels the exact production job without starting a new generation", async () => {
    const output = await outputDirectory();
    await writeState(output, {
      schema_version: "3",
      attempt_id: "temperature-case-system-a-r1",
      course_id: 123,
      short_name: "exgenexisting",
      phase: "generation_started",
      exercise_id: 44,
      job_id: "job-existing",
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    let cancelled = false;
    const { baseUrl, recorded } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=recovery-token; Path=/; HttpOnly" });
      if (url.pathname.endsWith("/generate-exercise/status")) {
        return json({
          jobId: "job-existing",
          running: !cancelled,
          mode: "GENERATE",
          ownedByCaller: true,
          events: cancelled
            ? [{ type: "CANCELLED", message: "Cancelled", timestamp: "2026-07-31T10:01:00Z" }]
            : [started],
          fileChanges: [],
          accountingState: cancelled ? "COMPLETE" : "PENDING",
          ...(cancelled ? { usage: usage() } : {}),
        });
      }
      if (incoming.method === "DELETE" && url.pathname.endsWith("/jobs/job-existing")) {
        cancelled = true;
        return new Response(null, { status: 200 });
      }
      return json({ error: "unexpected" }, 500);
    });

    await new ArtemisGenerator(request(output, baseUrl), output).recover(
      new AbortController().signal,
    );
    expect(
      recorded.filter(
        (entry) => entry.method === "DELETE" && entry.path.endsWith("/jobs/job-existing"),
      ),
    ).toHaveLength(1);
    expect(startedGeneration(recorded)).toHaveLength(0);
  });
});

describe("Artemis adapter state and job ownership", () => {
  test("rejects adapter state from another attempt without touching the remote instance", async () => {
    const output = await outputDirectory();
    await writeState(output, {
      schema_version: "3",
      attempt_id: "some-other-attempt",
      course_id: 999,
      short_name: "exgenforeign",
      phase: "generation_started",
      exercise_id: 7,
      job_id: "job-foreign",
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const { baseUrl, recorded } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("attempt_id");
    expect(result.message).toContain("course_id: expected 123, observed 999");
    expect(mutations(recorded)).toHaveLength(0);
  });

  test("refuses a truncated state file without touching the remote instance", async () => {
    const output = await outputDirectory();
    await mkdir(join(output, "artemis"), { recursive: true });
    await writeFile(
      join(output, "artemis", "adapter-state.json"),
      '{"schema_version":"3","attempt_id":"temperature-case-system-a-r1","course_id":123,"exer',
    );
    const { baseUrl, recorded } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("Artemis adapter state is not valid JSON");
    expect(mutations(recorded)).toHaveLength(0);
  });

  test.each([
    ["course_id", { course_id: "123" }, "course_id"],
    ["phase", { phase: "halfway" }, "phase"],
    ["exercise_id", { exercise_id: -1 }, "exercise_id"],
    ["deadline_at", { deadline_at: "yesterday" }, "deadline_at"],
    ["an unknown field", { rogue_field: true }, "rogue_field"],
  ])(
    "refuses a state file whose %s is wrong, naming the field and mutating nothing",
    async (_label, override, named) => {
      const output = await outputDirectory();
      await writeState(output, {
        schema_version: "3",
        attempt_id: "temperature-case-system-a-r1",
        course_id: 123,
        short_name: SHORT_NAME,
        phase: "generation_started",
        exercise_id: 44,
        job_id: "job-existing",
        deadline_at: new Date(Date.now() + 30_000).toISOString(),
        ...override,
      });
      const { baseUrl, recorded } = mockServer(productionHandler());

      const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
        new AbortController().signal,
      );

      expect(result.status).toBe("infra_failed");
      expect(result.message).toContain("Artemis adapter state is malformed");
      expect(result.message).toContain(named);
      expect(mutations(recorded)).toHaveLength(0);
    },
  );

  test("never issues a second generation start for a state file that already names a job", async () => {
    const output = await outputDirectory();
    await writeState(output, {
      schema_version: "3",
      attempt_id: "temperature-case-system-a-r1",
      course_id: 123,
      short_name: SHORT_NAME,
      phase: "generation_started",
      exercise_id: 44,
      job_id: "job-1",
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const { baseUrl, recorded } = mockServer(productionHandler({ generationStarted: true }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("succeeded");
    expect(startedGeneration(recorded)).toHaveLength(0);
    expect(recorded.some((entry) => entry.path.includes("/setup"))).toBe(false);
  });

  test("adopts an exercise that already exists under the attempt short name", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(
      productionHandler({ listed: [{ id: 44, shortName: SHORT_NAME }] }),
    );

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("succeeded");
    expect(recorded.some((entry) => entry.path.includes("/setup"))).toBe(false);
    expect(startedGeneration(recorded)).toHaveLength(1);
  });

  test("refuses a course that lists the attempt short name more than once", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(
      productionHandler({
        listed: [
          { id: 44, shortName: SHORT_NAME },
          { id: 45, shortName: SHORT_NAME },
        ],
      }),
    );

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain(`duplicate exercise shortName ${SHORT_NAME}`);
  });

  test("fails immediately when Artemis creates the exercise under a different short name", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(
      productionHandler({ setupShortName: "created-short-name" }),
    );

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain(SHORT_NAME);
    expect(result.message).toContain("created-short-name");
    expect(startedGeneration(recorded)).toHaveLength(0);
  });

  test("refuses to adopt a running generation job that this attempt does not own", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise/status"))
        return json({
          jobId: "job-foreign",
          running: true,
          events: [],
          fileChanges: [],
          ownedByCaller: false,
          cancellable: false,
          accountingState: "PENDING",
        });
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("job-foreign");
    expect(result.message).toContain("must not adopt");
    expect(startedGeneration(recorded)).toHaveLength(0);
  });

  test("refuses to adopt an adaptation job running on the same exercise", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise/status"))
        return json({
          jobId: "job-adapt",
          running: true,
          mode: "ADAPT",
          events: [],
          fileChanges: [],
          ownedByCaller: true,
          accountingState: "PENDING",
        });
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("mode=ADAPT");
  });

  test("resolves a start conflict through the status endpoint that names the running job", async () => {
    const output = await outputDirectory();
    let conflicted = false;
    const handler = productionHandler({ generationStarted: true });
    const { baseUrl, recorded } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        conflicted = true;
        return json(
          {
            title: "Exercise generation is already running for this exercise",
            errorKey: "exerciseGenerationRunning",
          },
          409,
        );
      }
      if (url.pathname.endsWith("/generate-exercise/status") && !conflicted)
        return new Response(null, { status: 204 });
      return handler(incoming);
    });

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("succeeded");
    expect(result.extensions.artemis).toMatchObject({ job_id: "job-1" });
    expect(startedGeneration(recorded)).toHaveLength(1);
  });

  test("does not adopt a foreign job after a start conflict", async () => {
    const output = await outputDirectory();
    let conflicted = false;
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        conflicted = true;
        return json({ errorKey: "exerciseGenerationRunning" }, 409);
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (!conflicted) return new Response(null, { status: 204 });
        return json({
          jobId: "job-someone-else",
          running: true,
          events: [],
          fileChanges: [],
          ownedByCaller: false,
          accountingState: "PENDING",
        });
      }
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("job-someone-else");
  });

  test("rejects a status that belongs to a different generation job", async () => {
    const output = await outputDirectory();
    await writeState(output, {
      schema_version: "3",
      attempt_id: "temperature-case-system-a-r1",
      course_id: 123,
      short_name: SHORT_NAME,
      phase: "generation_started",
      exercise_id: 44,
      job_id: "job-mine",
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const { baseUrl } = mockServer(productionHandler({ generationStarted: true }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("different generation job");
  });

  test("rejects a generation that stops running without a terminal event", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST")
        return json({ jobId: "job-1" }, 202);
      if (url.pathname.endsWith("/generate-exercise/status"))
        return json({
          jobId: "job-1",
          running: false,
          mode: "GENERATE",
          ownedByCaller: true,
          events: [started],
          fileChanges: [],
          accountingState: "PENDING",
        });
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("stopped without a terminal event");
  });

  test("cancels the remote job when the attempt wall-time budget expires", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST")
        return json({ jobId: "job-slow" }, 202);
      if (url.pathname.endsWith("/generate-exercise/status"))
        return json({
          jobId: "job-slow",
          running: true,
          mode: "GENERATE",
          ownedByCaller: true,
          events: [started],
          fileChanges: [],
          accountingState: "PENDING",
        });
      if (incoming.method === "DELETE") return new Response(null, { status: 200 });
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { accounting_settle_ms: 1 }, { wall_time_ms: 2 }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("wall-time budget");
    expect(
      recorded.some(
        (entry) => entry.method === "DELETE" && entry.path.includes("/generate-exercise/jobs/"),
      ),
    ).toBe(true);
  });

  test("tolerates the Artemis event retention cap instead of discarding a long run", async () => {
    const output = await outputDirectory();
    const progress = (index: number) => ({
      type: "PROGRESS",
      message: `step ${index}`,
      timestamp: "2026-07-31T10:00:30Z",
    });
    const failure = {
      type: "ERROR",
      message: "Provider failed after admitted work",
      terminationReason: "RUN_FAILED",
      timestamp: "2026-07-31T10:01:00Z",
    };
    let polls = 0;
    let generationStarted = false;
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        generationStarted = true;
        return json({ jobId: "job-long" }, 202);
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (!generationStarted) return new Response(null, { status: 204 });
        polls += 1;
        const first = [started, ...Array.from({ length: 499 }, (_, index) => progress(index + 1))];
        const trimmed = [
          started,
          ...Array.from({ length: 497 }, (_, index) => progress(index + 3)),
          progress(500),
          failure,
        ];
        return json({
          jobId: "job-long",
          running: polls < 2,
          mode: "GENERATE",
          ownedByCaller: true,
          events: polls < 2 ? first : trimmed,
          fileChanges: [],
          usage: usage(),
          accountingState: "COMPLETE",
        });
      }
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.extensions.artemis).toMatchObject({ dropped_event_count: 2 });
    const journal = result.diagnostics.find((diagnostic) => diagnostic.id === "artemis-events");
    expect(journal?.record_count).toBe(503);
    const lines = (await readFile(join(output, "artemis", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[500]).toMatchObject({
      type: "artemis.events_truncated",
      dropped_event_count: 2,
      retained_event_count: 500,
    });
    expect(lines.at(-1)).toMatchObject({ type: "artemis.error" });
  });

  test("rejects a rewritten event history that the retention cap cannot explain", async () => {
    const output = await outputDirectory();
    let polls = 0;
    let generationStarted = false;
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        generationStarted = true;
        return json({ jobId: "job-1" }, 202);
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (!generationStarted) return new Response(null, { status: 204 });
        polls += 1;
        return json({
          jobId: "job-1",
          running: true,
          mode: "GENERATE",
          ownedByCaller: true,
          accountingState: "PENDING",
          events:
            polls < 2
              ? [started, { type: "PROGRESS", message: "one", timestamp: "2026-07-31T10:00:30Z" }]
              : [
                  started,
                  { type: "PROGRESS", message: "rewritten", timestamp: "2026-07-31T10:00:30Z" },
                ],
          fileChanges: [],
        });
      }
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { post_cancel_budget_ms: 50 }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("rewrote a previously observed generation event");
  });

  test("bounds the recorded event journal and removes an incomplete one", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { max_event_count: 1 }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.message).toContain("max_event_count");
    expect(await Bun.file(join(output, "artemis", "events.jsonl")).exists()).toBe(false);
  });

  test("bounds cumulative HTTP response bytes across a generation run", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(
      request(output, baseUrl, {
        max_http_response_bytes: 512,
        max_http_total_bytes: 512,
        max_artifact_bytes: 512,
      }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("infra_failed");
    expect(result.message).toMatch(/max_http_total_bytes|max_http_response_bytes/);
  });
});

describe("Artemis benchmark environment", () => {
  const telemetry = (
    overrides: Record<string, unknown> = {},
  ): NonNullable<ArtemisParameters["telemetry"]> =>
    artemisParametersSchema.parse({
      base_url: "https://artemis.example.edu",
      auth: { type: "bearer", token_env: "TOKEN" },
      course_id: 1,
      telemetry: {
        provider: "opentelemetry",
        traces_path_env: "ARTEMIS_OTEL_TRACES_PATH",
        artemis_otlp_endpoint: "http://exgen-otel:4318/v1/traces",
        content_capture: "required",
        ...overrides,
      },
    }).telemetry as NonNullable<ArtemisParameters["telemetry"]>;

  test("emits exactly the variables Artemis needs for benchmark capture", () => {
    const environment = benchmarkEnvironment(telemetry());

    expect(Object.keys(environment).sort()).toEqual(
      [
        "MANAGEMENT_LANGFUSE_ENABLED",
        "MANAGEMENT_LOGGING_EXPORT_OTLP_ENABLED",
        "MANAGEMENT_OPENTELEMETRY_ENABLED",
        "MANAGEMENT_OPENTELEMETRY_INSTRUMENTATION_GEN_AI_CAPTURE_CONTENT",
        "MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_ENDPOINT",
        "MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_TRANSPORT",
        "MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_SCHEDULE_DELAY",
        "MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED",
        "MANAGEMENT_TRACING_EXPORT_OTLP_ENABLED",
        "MANAGEMENT_TRACING_SAMPLING_PROBABILITY",
        "SPRING_AI_OPENAI_MAX_RETRIES",
      ].sort(),
    );
    expect(environment).toMatchObject({
      MANAGEMENT_LANGFUSE_ENABLED: "false",
      MANAGEMENT_OPENTELEMETRY_ENABLED: "true",
      MANAGEMENT_TRACING_SAMPLING_PROBABILITY: "1.0",
      MANAGEMENT_TRACING_EXPORT_OTLP_ENABLED: "true",
      MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_ENDPOINT: "http://exgen-otel:4318/v1/traces",
      MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_TRANSPORT: "http",
      MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_SCHEDULE_DELAY: "1s",
      MANAGEMENT_LOGGING_EXPORT_OTLP_ENABLED: "false",
      MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED: "false",
      SPRING_AI_OPENAI_MAX_RETRIES: "0",
    });
  });

  test("binds gen-AI content capture to the configured content policy", () => {
    expect(
      benchmarkEnvironment(telemetry({ content_capture: "required" }))
        .MANAGEMENT_OPENTELEMETRY_INSTRUMENTATION_GEN_AI_CAPTURE_CONTENT,
    ).toBe("true");
    expect(
      benchmarkEnvironment(telemetry({ content_capture: "forbidden" }))
        .MANAGEMENT_OPENTELEMETRY_INSTRUMENTATION_GEN_AI_CAPTURE_CONTENT,
    ).toBe("false");
  });

  test("emits no value that looks like a credential", () => {
    const environment = benchmarkEnvironment(telemetry());
    for (const [name, value] of Object.entries(environment)) {
      expect(value, name).not.toMatch(/secret|password|token|api[-_]?key|bearer\s/i);
      expect(value, name).not.toMatch(/^(?:sk-|eyJ)/);
      expect(value.length, name).toBeLessThan(64);
    }
    expect(Object.values(environment)).not.toContain(process.env.ARTEMIS_TEST_PASSWORD);
  });
});

describe("Artemis adapter configuration", () => {
  test("requires TLS for authenticated connections outside loopback", () => {
    for (const auth of [
      { type: "password", username_env: "USER", password_env: "PASSWORD" },
      { type: "bearer", token_env: "TOKEN" },
    ]) {
      expect(
        artemisParametersSchema.safeParse({
          base_url: "http://artemis.example.edu",
          auth,
          course_id: 1,
        }).success,
      ).toBe(false);
    }
    expect(() =>
      artemisParametersSchema.parse({
        base_url: "http://artemis.example.edu",
        auth: { type: "bearer", token_env: "TOKEN" },
        course_id: 1,
      }),
    ).toThrow("HTTPS");
  });

  test("requires a campaign to state its content-capture tier rather than defaulting to one", () => {
    const telemetry = {
      provider: "opentelemetry",
      traces_path_env: "ARTEMIS_OTEL_TRACES_PATH",
      artemis_otlp_endpoint: "http://exgen-otel:4318/v1/traces",
    };
    const parameters = {
      base_url: "https://artemis.example.edu",
      auth: { type: "bearer", token_env: "TOKEN" },
      course_id: 1,
    };

    expect(artemisParametersSchema.safeParse({ ...parameters, telemetry }).success).toBe(false);
    for (const tier of ["required", "forbidden"] as const) {
      const parsed = artemisParametersSchema.parse({
        ...parameters,
        telemetry: { ...telemetry, content_capture: tier },
      });
      expect(parsed.telemetry?.content_capture).toBe(tier);
    }
  });

  test("accepts every loopback form and refuses a hostname that merely looks like one", () => {
    for (const baseUrl of [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://127.5.6.7:8080",
      "http://[::1]:8080",
    ]) {
      expect(
        artemisParametersSchema.safeParse({
          base_url: baseUrl,
          auth: { type: "bearer", token_env: "TOKEN" },
          course_id: 1,
        }).success,
        baseUrl,
      ).toBe(true);
    }
    for (const baseUrl of ["http://127.evil.example.com", "http://localhost.evil.example.com"]) {
      expect(
        artemisParametersSchema.safeParse({
          base_url: baseUrl,
          auth: { type: "bearer", token_env: "TOKEN" },
          course_id: 1,
        }).success,
        baseUrl,
      ).toBe(false);
    }
  });

  test("runs as a real executable and honours EXGEN_ADAPTER_ID", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "adapters/artemis/adapter.ts", "describe", "--json"],
      cwd: join(import.meta.dir, ".."),
      env: { ...Bun.env, EXGEN_ADAPTER_ID: "artemis-approach-a" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(generatorDescriptorSchema.parse(JSON.parse(stdout)).id).toBe("artemis-approach-a");
  });

  test("refuses an adapter id that presents this binary as a different system", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "adapters/artemis/adapter.ts", "describe", "--json"],
      cwd: join(import.meta.dir, ".."),
      env: { ...Bun.env, EXGEN_ADAPTER_ID: "hyperion-baseline" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("EXGEN_ADAPTER_ID");
  });
});

describe("Artemis terminal status wire compatibility", () => {
  const RECORDED_TERMINAL_STATUS = {
    jobId: "c8dc63bc-35ec-41b2-8431-ee8b857b20d4",
    running: false,
    mode: "GENERATE",
    events: [started, terminalDone()],
    fileChanges: [],
    revertAvailable: false,
    ownedByCaller: true,
    cancellable: false,
    usage: {
      modelCalls: 5,
      toolCalls: 0,
      agentTurns: 2,
      attempts: 1,
      inputTokens: 10592,
      outputTokens: 9206,
      cachedInputTokens: 0,
      cachedInputTokensComplete: false,
      estimatedCostEur: 0,
      estimatedCostEurComplete: false,
      models: ["openai/gpt-oss-120b"],
      providerRequestIds: [
        "chatcmpl-906e5a62a5edccd3",
        "chatcmpl-9a498277ec92663d",
        "chatcmpl-97ca83ea5e27116c",
        "chatcmpl-bf67d9e1546ec98a",
        "chatcmpl-8ca944d74215921d",
      ],
      providerRequestIdsComplete: true,
    },
    accountingState: "COMPLETE",
    effortProfile: "draft",
  };

  test("parses the terminal status Artemis actually sends", () => {
    const parsed = generationStatusSchema.parse(RECORDED_TERMINAL_STATUS);
    expect(parsed.accountingState).toBe("COMPLETE");
    expect(parsed.effortProfile).toBe("draft");
    expect(parsed.usage?.agentTurns).toBe(2);
    expect(parsed.usage?.attempts).toBe(1);
  });

  test("tolerates a usage field it does not read but not a renamed one it does", () => {
    expect(
      generationStatusSchema.safeParse({
        ...RECORDED_TERMINAL_STATUS,
        usage: { ...RECORDED_TERMINAL_STATUS.usage, someLaterAddition: 3 },
      }).success,
    ).toBe(true);
    const { inputTokens: _renamed, ...withoutInputTokens } = RECORDED_TERMINAL_STATUS.usage;
    expect(
      generationStatusSchema.safeParse({
        ...RECORDED_TERMINAL_STATUS,
        usage: { ...withoutInputTokens, promptTokens: 10592 },
      }).success,
    ).toBe(false);
    const { accountingState: _seal, ...withoutSeal } = RECORDED_TERMINAL_STATUS;
    expect(generationStatusSchema.safeParse(withoutSeal).success).toBe(false);
  });

  test("recovery reads a real terminal status instead of wedging the attempt", async () => {
    const output = await outputDirectory();
    await writeState(output, {
      schema_version: "3",
      attempt_id: "temperature-case-system-a-r1",
      course_id: 123,
      short_name: SHORT_NAME,
      phase: "generation_started",
      exercise_id: 44,
      job_id: "job-1",
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const { baseUrl, recorded } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname.endsWith("/generate-exercise/status"))
        return json({ ...RECORDED_TERMINAL_STATUS, jobId: "job-1" });
      return json({ error: "unexpected" }, 500);
    });

    await new ArtemisGenerator(request(output, baseUrl), output).recover(
      new AbortController().signal,
    );

    expect(recorded.filter((entry) => entry.method === "DELETE")).toHaveLength(0);
    expect(startedGeneration(recorded)).toHaveLength(0);
  });

  test("stops settling on a permanent lower bound instead of waiting out the window", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler({ accountingState: "INCOMPLETE" }));

    const startedAt = Date.now();
    const result = await new ArtemisGenerator(
      request(output, baseUrl, { accounting_settle_ms: 4_000 }, { wall_time_ms: 30_000 }),
      output,
    ).generate(new AbortController().signal);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(result.usage).toBeUndefined();
    expect(result.extensions.artemis).toMatchObject({
      accounting_state: "INCOMPLETE",
      usage_accounting_complete: false,
    });
  });

  test("reports the turn accounting Artemis added for exactly this question", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.extensions.artemis).toMatchObject({
      accounting_state: "COMPLETE",
      agent_turns: 9,
      authoring_attempts: 2,
    });
  });
});

describe("Artemis retained candidate", () => {
  const RETAINED_FILES = [
    { repo: "template", path: "src/main/java/Solver.java", content: "class Solver {}\n" },
    { repo: "solution", path: "src/main/java/Solver.java", content: "class Solver { int f; }\n" },
    { repo: "tests", path: "src/test/java/SolverTest.java", content: "class SolverTest {}\n" },
  ];

  function retaining(
    overrides: Record<string, unknown> = {},
    handlerOptions: Parameters<typeof productionHandler>[0] = {},
  ) {
    const terminal = {
      type: "ERROR",
      message: "The agent loop ended with an error.",
      terminationReason: "AGENT_ERROR",
      timestamp: "2026-07-31T10:01:00Z",
    };
    const handler = productionHandler({ terminal, ...handlerOptions });
    return (incoming: Request): Response => {
      if (new URL(incoming.url).pathname.endsWith("/generate-exercise/artifacts")) {
        // `status` is the HTTP status of the retention response, not a body field.
        if (typeof overrides.status === "number")
          return json({ error: "no candidate" }, overrides.status);
        return json({
          jobId: "job-1",
          completeness: "COMPLETE",
          problemStatement: "# Solver\n\nImplement the solver.",
          specDocument: "# SPEC\n\nThe agent's plan.",
          files: RETAINED_FILES,
          ...overrides,
        });
      }
      return handler(incoming);
    };
  }

  test("keeps the candidate a run produced but never saved", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(retaining());

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.extensions.artemis).toMatchObject({ termination_reason: "AGENT_ERROR" });
    expect(result.artifacts.map((artifact) => artifact.role).sort()).toEqual([
      "problem_statement",
      "solution",
      "template",
      "tests",
    ]);
    expect(result.capture.completeness).toBe("complete");
    expect(
      await readFile(join(output, "artifacts", "solution", "src/main/java/Solver.java"), "utf8"),
    ).toContain("int f");
    expect(await readFile(join(output, "artifacts", "problem-statement.md"), "utf8")).toContain(
      "Implement the solver",
    );
    expect(result.extensions.artemis).toMatchObject({
      // Three repository files plus the problem statement.
      retained_candidate: { status: "captured", file_count: 4, completeness: "complete" },
    });
    await expect(validateAndDigestArtifacts(result, output)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  test("copies the completeness Artemis states rather than deriving one", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(retaining({ completeness: "PARTIAL" }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.capture.completeness).toBe("partial");
    expect(result.artifacts).not.toHaveLength(0);
  });

  test("never calls a partial generation a complete capture", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(
      retaining(
        {},
        {
          terminal: {
            type: "DONE",
            message: "Saving did not complete; manual review is required.",
            completionStatus: "PARTIAL",
            terminationReason: "SAVE_INTERRUPTED",
            timestamp: "2026-07-31T10:01:00Z",
          },
        },
      ),
    );

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.extensions.artemis).toMatchObject({
      completion_status: "PARTIAL",
      retained_candidate: { status: "captured", completeness: "complete" },
    });
    expect(result.capture.completeness).toBe("partial");
  });

  test("treats nothing retained as an ordinary outcome, not a failure", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(retaining({ status: 404 }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.artifacts).toEqual([]);
    expect(result.capture.completeness).toBe("none");
    expect(result.extensions.artemis).toMatchObject({ retained_candidate: { status: "absent" } });
    expect(result.message).toBe("The agent loop ended with an error.");
  });

  test("keeps the attempt failed when the retention endpoint itself fails", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(retaining({ status: 500 }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.artifacts).toEqual([]);
    expect(result.extensions.artemis).toMatchObject({
      retained_candidate: { status: "unavailable", reason: expect.stringContaining("HTTP 500") },
    });
  });

  test("reports no capture when Artemis retained an empty candidate", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(retaining({ files: [], problemStatement: "" }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.artifacts).toEqual([]);
    expect(result.capture.completeness).toBe("none");
    expect(result.extensions.artemis).toMatchObject({ retained_candidate: { status: "absent" } });
  });

  test("declares only the repositories the run actually wrote to", async () => {
    const output = await outputDirectory();
    // A run that dies at the spec gate routinely leaves one repository and no other.
    const { baseUrl } = mockServer(
      retaining({
        files: [{ repo: "tests", path: "src/test/java/T.java", content: "class T {}\n" }],
      }),
    );

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.artifacts.map((artifact) => artifact.role).sort()).toEqual([
      "problem_statement",
      "tests",
    ]);
    await expect(validateAndDigestArtifacts(result, output)).resolves.toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(join(output, "artifacts", "template")).exists()).toBe(false);
  });

  test("refuses a retained path that would escape the artifact directory", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(
      retaining({ files: [{ repo: "tests", path: "../escape.java", content: "class E {}\n" }] }),
    );

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.artifacts).toEqual([]);
    expect(result.extensions.artemis).toMatchObject({
      retained_candidate: { status: "unavailable", reason: expect.stringContaining("unsafe") },
    });
    // The path escapes artifacts/tests, so artifacts/ is where it would land.
    expect(await Bun.file(join(output, "artifacts", "escape.java")).exists()).toBe(false);
  });

  test("does not attribute an earlier run's candidate to this attempt", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(retaining({ jobId: "job-from-an-earlier-run" }));

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect(result.artifacts).toEqual([]);
    expect(result.extensions.artemis).toMatchObject({
      retained_candidate: { status: "other_job", reason: expect.stringContaining("another run") },
    });
  });

  test("bounds a retained candidate that would exceed the artifact budget", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(
      retaining({ files: [{ repo: "tests", path: "big.java", content: "x".repeat(4096) }] }),
    );

    const result = await new ArtemisGenerator(
      // Large enough to receive the payload, small enough that materialising it breaches the
      // artifact budget: the bound under test is the artifact one, not the transport one.
      request(output, baseUrl, { max_artifact_bytes: 1024, max_http_response_bytes: 65_536 }),
      output,
    ).generate(new AbortController().signal);

    expect(result.artifacts).toEqual([]);
    expect(result.extensions.artemis).toMatchObject({
      retained_candidate: {
        status: "unavailable",
        reason: expect.stringContaining("max_artifact_bytes"),
      },
    });
    expect(await Bun.file(join(output, "artifacts", "problem-statement.md")).exists()).toBe(false);
  });

  test("does not fetch a candidate on the cancellation path", async () => {
    const output = await outputDirectory();
    const controller = new AbortController();
    let generationStarted = false;
    let cancelled = false;
    const { baseUrl, recorded } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise/artifacts"))
        return json({ jobId: "job-1", completeness: "PARTIAL", files: RETAINED_FILES });
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        generationStarted = true;
        setTimeout(() => controller.abort(new Error("test cancellation")), 5);
        return json({ jobId: "job-1" }, 202);
      }
      if (url.pathname.endsWith("/jobs/job-1") && incoming.method === "DELETE") {
        cancelled = true;
        return new Response(null, { status: 200 });
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (!generationStarted) return new Response(null, { status: 204 });
        return json({
          jobId: "job-1",
          running: !cancelled,
          mode: "GENERATE",
          events: cancelled
            ? [started, { type: "CANCELLED", message: "c", timestamp: "2026-07-31T10:01:00Z" }]
            : [started],
          fileChanges: [],
          ownedByCaller: true,
          accountingState: cancelled ? "COMPLETE" : "PENDING",
          ...(cancelled ? { usage: usage() } : {}),
        });
      }
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      controller.signal,
    );

    // A cancelled attempt is never evaluated, so a candidate fetched here would be evidence nobody
    // can read, bought with a round-trip on the cancellation path.
    expect(result.status).toBe("failed");
    expect(result.artifacts).toEqual([]);
    expect(recorded.some((entry) => entry.path.endsWith("/generate-exercise/artifacts"))).toBe(
      false,
    );
    expect(await Bun.file(join(output, "artifacts", "template")).exists()).toBe(false);
    expect(result.extensions.artemis).not.toHaveProperty("retained_candidate");
  });

  test("backs the failed_artifact_capture capability it declares", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "adapters/artemis/adapter.ts", "describe", "--json"],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(0);
    const declared = generatorDescriptorSchema.parse(JSON.parse(stdout)).capabilities
      .failed_artifact_capture;

    const output = await outputDirectory();
    const { baseUrl } = mockServer(retaining());
    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.artifacts.length, `declared ${declared}`).toBeGreaterThan(0);
    // `partial` specifically: a failed attempt yields the retained candidate but never the
    // commit-pinned export, because nothing was committed and no exercise version exists.
    expect(declared).toBe("partial");
    expect(await Bun.file(join(output, "artemis", "generation-evidence.json")).exists()).toBe(
      false,
    );
  });
});

describe("Artemis retained candidate bounds", () => {
  const limits = { maxBytes: 1_000_000, maxFiles: 3 };
  const file = (path: string, repo: "template" | "solution" | "tests" = "tests") => ({
    repo,
    path,
    content: "class T {}\n",
  });

  test("refuses two retained files that claim the same repository path", async () => {
    const output = await outputDirectory();
    await expect(
      materializeRetainedCandidate(output, { files: [file("a/T.java"), file("a/T.java")] }, limits),
    ).rejects.toThrow("duplicate path");
  });

  test("keeps the same path in two repositories, which is the ordinary case", async () => {
    const output = await outputDirectory();
    // template/ and solution/ hold the same file at the same path by construction.
    const materialized = await materializeRetainedCandidate(
      output,
      { files: [file("a/T.java", "template"), file("a/T.java", "solution")] },
      limits,
    );
    expect(materialized.artifacts).toHaveLength(2);
    expect(materialized.fileCount).toBe(2);
  });

  test("writes nothing at all when a candidate breaches the byte bound", async () => {
    const output = await outputDirectory();
    await expect(
      materializeRetainedCandidate(
        output,
        { problemStatement: "# Solver\n", files: [file("a/T.java"), file("b/T.java")] },
        { maxBytes: 12, maxFiles: 3 },
      ),
    ).rejects.toThrow("max_artifact_bytes");

    // A half-written tree would be hashed into the evidence manifest without being declared.
    expect(await Bun.file(join(output, "artifacts", "problem-statement.md")).exists()).toBe(false);
    expect(await Bun.file(join(output, "artifacts", "tests", "a", "T.java")).exists()).toBe(false);
  });

  test("refuses more retained files than the configured bound", async () => {
    const output = await outputDirectory();
    await expect(
      materializeRetainedCandidate(
        output,
        { files: [file("a.java"), file("b.java"), file("c.java"), file("d.java")] },
        limits,
      ),
    ).rejects.toThrow("max_archive_files");
  });
});

describe("Artemis generation factors", () => {
  test("applies a requested effort profile and reports the one Artemis resolved", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(productionHandler({ effortProfile: "draft" }));

    const result = await new ArtemisGenerator(
      withFactors(request(output, baseUrl), { effort_profile: "draft" }),
      output,
    ).generate(new AbortController().signal);

    expect(startedGeneration(recorded)[0]?.body).toMatchObject({
      mode: "GENERATE",
      effortProfile: "draft",
    });
    expect(result.execution?.observed_factors).toEqual({ effort_profile: "draft" });
    expect(result.extensions.artemis).toMatchObject({ effort_profile: "draft" });
  });

  test("reports what ran rather than what it asked for when the two differ", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler({ effortProfile: "standard" }));

    const result = await new ArtemisGenerator(
      withFactors(request(output, baseUrl), { effort_profile: "draft" }),
      output,
    ).generate(new AbortController().signal);

    expect(result.execution?.observed_factors).toEqual({ effort_profile: "standard" });
  });

  test("reports the resolved profile on a failed attempt too", async () => {
    const output = await outputDirectory();
    const terminal = {
      type: "ERROR",
      message: "The agent loop ended with an error.",
      terminationReason: "AGENT_ERROR",
      timestamp: "2026-07-31T10:01:00Z",
    };
    const { baseUrl } = mockServer(productionHandler({ terminal, effortProfile: "standard" }));

    const result = await new ArtemisGenerator(
      withFactors(request(output, baseUrl), { effort_profile: "draft" }),
      output,
    ).generate(new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.execution?.observed_factors).toEqual({ effort_profile: "standard" });
  });

  test("sends the per-request bounds Artemis may only tighten with", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(productionHandler());

    await new ArtemisGenerator(
      request(output, baseUrl, {
        generation: { max_tokens: 600_000, max_job_duration_ms: 900_000 },
      }),
      output,
    ).generate(new AbortController().signal);

    expect(startedGeneration(recorded)[0]?.body).toMatchObject({
      maxTokens: 600_000,
      maxJobDuration: "PT900S",
    });
  });

  test("declares exactly the factors it applies and the ones it can vouch for", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "adapters/artemis/adapter.ts", "describe", "--json"],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const capabilities = generatorDescriptorSchema.parse(JSON.parse(stdout)).capabilities;

    expect(capabilities.controls).toEqual(["effort_profile"]);
    expect(capabilities.observes).toEqual(["effort_profile"]);
    for (const name of ["max_tokens", "max_job_duration_ms"]) {
      expect(capabilities.controls).not.toContain(name);
      expect(capabilities.observes).not.toContain(name);
    }
    for (const name of [...(capabilities.controls ?? []), ...(capabilities.observes ?? [])]) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(() => resolveRequestedFactors({ [name]: "draft" }, {})).not.toThrow();
    }
    expect(Object.keys(observedFactors("draft"))).toEqual(capabilities.observes ?? []);
  });

  test("refuses a requested factor it would otherwise silently drop", () => {
    for (const [factors, message] of [
      [{ effort_profile: "draft", planner_model: "x" }, "planner_model"],
      [{ max_tokens: 600_000 }, "parameters.generation.max_tokens"],
      [{ max_job_duration_ms: 900_000 }, "parameters.generation.max_job_duration_ms"],
      [{ effort_profile: 7 }, "effort_profile must be"],
      [{ "artemis.effort_profile": "draft" }, "artemis.effort_profile"],
      [{ effortProfile: "draft" }, "effortProfile"],
    ] as Array<[Record<string, string | number | boolean>, string]>) {
      expect(() => resolveRequestedFactors(factors, {}), JSON.stringify(factors)).toThrow(message);
    }
  });

  test("a factor overrides the parameter default for the same control", () => {
    expect(
      resolveRequestedFactors({ effort_profile: "draft" }, { effortProfile: "standard" }),
    ).toEqual({ effortProfile: "draft" });
    expect(resolveRequestedFactors({}, { effortProfile: "standard" })).toEqual({
      effortProfile: "standard",
    });
  });

  test("refuses an unconfigured profile before it creates anything", async () => {
    const output = await outputDirectory();
    const handler = productionHandler({ profiles: [{ name: "standard", label: "Standard" }] });
    const { baseUrl, recorded } = mockServer(handler);

    await expect(
      new ArtemisGenerator(
        withFactors(request(output, baseUrl), { effort_profile: "thorough" }),
        output,
      ).generate(new AbortController().signal),
    ).rejects.toThrow("thorough");

    expect(mutations(recorded)).toHaveLength(0);
  });
});

describe("Artemis exercise format", () => {
  test("carries the format through target parameters rather than through hardcoded constants", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(
      productionHandler({ packageName: `de.tum.${PACKAGE_NAME}` }),
    );

    const result = await new ArtemisGenerator(
      request(
        output,
        baseUrl,
        {},
        {},
        {
          static_code_analysis: true,
          hidden_tests: false,
          max_points: 42,
          difficulty: "HARD",
          release_lead_ms: 3_600_000,
          package_prefix: "de.tum",
        },
      ),
      output,
    ).generate(new AbortController().signal);

    const setup = bodyOf(
      recorded.find((entry) => entry.path.endsWith("/setup?emptyRepositories=true")),
    );
    expect(setup).toMatchObject({
      staticCodeAnalysisEnabled: true,
      maxPoints: 42,
      difficulty: "HARD",
      programmingLanguage: "JAVA",
      projectType: "PLAIN_MAVEN",
      packageName: `de.tum.${PACKAGE_NAME}`,
    });
    expect(setup.dueDate).toBeUndefined();
    expect(setup.assessmentDueDate).toBeUndefined();
    expect(Date.parse(String(setup.releaseDate)) - Date.now()).toBeLessThan(2 * 3_600_000);
    expect(result.execution?.effective_parameters).toMatchObject({
      exercise_format: { static_code_analysis: true, hidden_tests: false, max_points: 42 },
    });
  });

  test("sets a due date only when hidden tests are requested", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(productionHandler());

    await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    const setup = bodyOf(
      recorded.find((entry) => entry.path.endsWith("/setup?emptyRepositories=true")),
    );
    expect(typeof setup.dueDate).toBe("string");
    expect(typeof setup.assessmentDueDate).toBe("string");
    expect(setup.staticCodeAnalysisEnabled).toBe(false);
    expect(setup.buildConfig).toMatchObject({ sequentialTestRuns: false });
  });

  test("sends the sequential-test-runs treatment the static-analysis rule is stated against", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(productionHandler());

    await new ArtemisGenerator(
      request(output, baseUrl, {}, {}, { sequential_test_runs: true }),
      output,
    ).generate(new AbortController().signal);

    const setup = bodyOf(
      recorded.find((entry) => entry.path.endsWith("/setup?emptyRepositories=true")),
    );
    expect(setup.buildConfig).toMatchObject({ sequentialTestRuns: true });
  });

  test("derives the package name from the attempt rather than from the case title", async () => {
    const output = await outputDirectory();
    const { baseUrl, recorded } = mockServer(productionHandler());
    const base = request(output, baseUrl);
    const renamed = {
      ...base,
      case: { ...base.case, title: "A Completely Different Exercise Title" },
    };

    await new ArtemisGenerator(renamed, output).generate(new AbortController().signal);

    const setup = bodyOf(
      recorded.find((entry) => entry.path.endsWith("/setup?emptyRepositories=true")),
    );
    expect(setup.title).toBe(`A Completely Different Exercise Title ${SHORT_NAME}`);
    expect(setup.packageName).toBe(PACKAGE_NAME);
  });

  test("gives two arms of the same case titles Artemis will not reject as duplicates", async () => {
    const titles: string[] = [];
    for (const arm of ["artemis-draft", "artemis-standard"]) {
      const output = await outputDirectory();
      const { baseUrl, recorded } = mockServer(productionHandler());
      const base = request(output, baseUrl);
      const armed = { ...base, attempt: { ...base.attempt, id: `encapsulation--${arm}--r001` } };
      await new ArtemisGenerator(armed, output).generate(new AbortController().signal);
      const setup = recorded.find((entry) => entry.path.endsWith("/setup?emptyRepositories=true"));
      titles.push(String(bodyOf(setup).title));
    }
    expect(titles[0]).toContain("Temperature Alert Classification");
    expect(titles[0]).not.toBe(titles[1]);
  });

  test("rejects the format combinations Artemis answers with a 400", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ static_code_analysis: true, sequential_test_runs: true }, "sequential test runs"],
      [{ static_code_analysis: true, project_type: "FACT", language: "C" }, "FACT"],
      [{ language: "PYTHON", project_type: "PLAIN_MAVEN" }, "rejects a project type"],
      [{ language: "JAVA", project_type: null }, "requires one of"],
      [{ language: "PYTHON", project_type: null, package_prefix: "de.tum" }, "package name"],
      [{ project_type: "PLAIN_GRADLE", build_system: "maven" }, "builds with gradle"],
    ];
    for (const [parameters, message] of cases) {
      const outcome = artemisTargetParametersSchema.safeParse(parameters);
      expect(outcome.success, JSON.stringify(parameters)).toBe(false);
      expect(JSON.stringify(outcome.error?.issues), JSON.stringify(parameters)).toContain(message);
    }
  });

  test("refuses target parameters that contradict a format-naming target identifier", () => {
    expect(() =>
      resolveTargetFormat("artemis-java-maven", { language: "PYTHON", project_type: null }),
    ).toThrow("artemis-java-maven");
    expect(() =>
      resolveTargetFormat("artemis-java-maven", { language: "JAVA", project_type: "PLAIN_GRADLE" }),
    ).toThrow("artemis-java-maven");
    expect(
      resolveTargetFormat("artemis-java-maven", { project_type: "MAVEN_MAVEN" }),
    ).toMatchObject({ language: "JAVA", project_type: "MAVEN_MAVEN" });
    expect(
      resolveTargetFormat("artemis-programming-exercise", {
        language: "PYTHON",
        project_type: null,
      }),
    ).toMatchObject({ language: "PYTHON" });
  });
});

describe("Artemis published parameters schema", () => {
  test("accepts the configurations the adapter itself accepts", async () => {
    const { stdout } = await runAdapterCli(["describe", "--json"]);
    const schema = generatorDescriptorSchema.parse(JSON.parse(stdout)).parameters_schema;
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema as object);

    const minimal = {
      base_url: "https://artemis.example.edu",
      auth: { type: "bearer", token_env: "TOKEN" },
      course_id: 1,
    };
    expect(artemisParametersSchema.safeParse(minimal).success).toBe(true);
    expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true);
    for (const defaulted of ["accounting_settle_ms", "post_cancel_budget_ms", "max_retry_delay_ms"])
      expect((schema as { required?: string[] }).required ?? []).not.toContain(defaulted);
  });
});

describe("Artemis owned-exercise view", () => {
  test("recognises the state records the adapter actually writes", () => {
    const complete = {
      schema_version: "3",
      attempt_id: "temperature-case-system-a-r1",
      course_id: 123,
      short_name: SHORT_NAME,
      phase: "terminal",
      exercise_id: 44,
      job_id: "job-1",
      deadline_at: "2026-08-01T00:00:00Z",
      telemetry_cursor_bytes: 12,
      terminal_version_id: 77,
    };
    expect(ownedExerciseSchema.safeParse(complete).success).toBe(true);
    expect(ownedExerciseSchema.parse(complete)).toMatchObject({ exercise_id: 44, course_id: 123 });
    const { exercise_id: _missing, ...withoutExercise } = complete;
    expect(ownedExerciseSchema.safeParse(withoutExercise).success).toBe(false);
    expect(ownedExerciseSchema.safeParse({ ...complete, course_id: "123" }).success).toBe(false);
  });
});

describe("Artemis measurement bounds", () => {
  test("refuses bounds that contradict each other rather than failing mid-campaign", () => {
    const base = {
      base_url: "https://artemis.example.edu",
      auth: { type: "bearer", token_env: "TOKEN" },
      course_id: 1,
    };
    const unreachable = artemisParametersSchema.safeParse({
      ...base,
      max_http_response_bytes: 1024,
      max_artifact_bytes: 2048,
    });
    expect(unreachable.success).toBe(false);
    expect(JSON.stringify(unreachable.error?.issues)).toContain("reachable through one HTTP");
    expect(
      artemisParametersSchema.safeParse({
        ...base,
        max_http_response_bytes: 2048,
        max_artifact_bytes: 2048,
      }).success,
    ).toBe(true);
  });

  test("refuses a settle window that cannot fit inside the wall-time budget", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());
    expect(
      () =>
        new ArtemisGenerator(
          request(output, baseUrl, { accounting_settle_ms: 30_000 }, { wall_time_ms: 30_000 }),
          output,
        ),
    ).toThrow("accounting_settle_ms");
  });

  test("clamps the accounting settle window to what is left of the wall-time budget", async () => {
    const output = await outputDirectory();
    let terminalFrom: number | undefined;
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        terminalFrom = Date.now() + 800;
        return json({ jobId: "job-1" }, 202);
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (terminalFrom === undefined) return new Response(null, { status: 204 });
        const terminal = Date.now() >= terminalFrom;
        return json({
          jobId: "job-1",
          running: !terminal,
          mode: "GENERATE",
          events: terminal
            ? [started, { type: "ERROR", message: "boom", timestamp: "2026-07-31T10:01:00Z" }]
            : [started],
          fileChanges: [],
          ownedByCaller: true,
          accountingState: "PENDING",
        });
      }
      if (incoming.method === "DELETE") return new Response(null, { status: 200 });
      return json({ error: "unexpected" }, 500);
    });

    const startedAt = Date.now();
    const result = await new ArtemisGenerator(
      request(output, baseUrl, { accounting_settle_ms: 1_100 }, { wall_time_ms: 1_200 }),
      output,
    ).generate(new AbortController().signal);
    const elapsed = Date.now() - startedAt;

    expect(result.status, result.message).toBe("failed");
    expect(result.extensions.artemis).toMatchObject({ usage_accounting_complete: false });
    expect(elapsed).toBeLessThan(1_500);
  });

  test("holds error-path accounting to the same settle window as the happy path", async () => {
    const output = await outputDirectory();
    const controller = new AbortController();
    let cancelledAt: number | undefined;
    let generationStarted = false;
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises") return json([]);
      if (url.pathname.endsWith("/setup"))
        return json({ id: 44, shortName: SHORT_NAME, packageName: PACKAGE_NAME }, 201);
      if (url.pathname.endsWith("/generate-exercise") && incoming.method === "POST") {
        generationStarted = true;
        setTimeout(() => controller.abort(new Error("test cancellation")), 5);
        return json({ jobId: "job-1" }, 202);
      }
      if (url.pathname.endsWith("/jobs/job-1") && incoming.method === "DELETE") {
        cancelledAt = Date.now();
        return new Response(null, { status: 200 });
      }
      if (url.pathname.endsWith("/generate-exercise/status")) {
        if (!generationStarted) return new Response(null, { status: 204 });
        const settled = cancelledAt !== undefined && Date.now() - cancelledAt >= 200;
        return json({
          jobId: "job-1",
          running: false,
          mode: "GENERATE",
          events: [started, { type: "CANCELLED", message: "c", timestamp: "2026-07-31T10:01:00Z" }],
          fileChanges: [],
          ownedByCaller: true,
          ...(settled
            ? { usage: usage(), accountingState: "COMPLETE" as const }
            : { accountingState: "PENDING" as const }),
        });
      }
      return json({ error: "unexpected" }, 500);
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, { accounting_settle_ms: 2_000, post_cancel_budget_ms: 60 }),
      output,
    ).generate(controller.signal);

    expect(result.status).toBe("failed");
    expect(result.usage).toMatchObject({ model_calls: 3, input_tokens: 1200 });
  });
});

describe("Artemis effective limits and model reporting", () => {
  test("records every limit as unknown when nothing declares one", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(request(output, baseUrl), output).generate(
      new AbortController().signal,
    );

    expect((result.extensions.artemis as { effective_limits: unknown[] }).effective_limits).toEqual(
      [
        { id: "max_job_duration_ms", source: "unknown" },
        { id: "max_tokens_per_job", source: "unknown" },
        { id: "max_turns", source: "unknown" },
        { id: "context_window_tokens", source: "unknown" },
        { id: "admission_max_tokens_per_user", source: "unknown" },
      ],
    );
    expect(result.execution?.effective_limits).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.execution?.effective_parameters).toMatchObject({ model: ["gpt-oss:120b"] });
  });

  test("distinguishes an operator declaration from what the server reported", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());

    const result = await new ArtemisGenerator(
      request(output, baseUrl, {
        model_provider: "local-vllm",
        server_limits: { max_job_duration_ms: 2_700_000, max_tokens_per_job: 3_000_000 },
      }),
      output,
    ).generate(new AbortController().signal);

    expect((result.extensions.artemis as { effective_limits: unknown[] }).effective_limits).toEqual(
      [
        { id: "max_job_duration_ms", source: "system_configured", value: 2_700_000 },
        { id: "max_tokens_per_job", source: "system_configured", value: 3_000_000 },
        { id: "max_turns", source: "unknown" },
        { id: "context_window_tokens", source: "unknown" },
        { id: "admission_max_tokens_per_user", source: "unknown" },
      ],
    );
    expect(result.execution?.effective_limits).toEqual({
      wall_time_ms: { value: 2_700_000, source: "system_configured" },
      total_tokens: { value: 3_000_000, source: "system_configured" },
    });
    expect(result.model).toEqual({ provider: "local-vllm", id: "gpt-oss:120b" });
  });

  test("prefers a limit the server reported over the same limit an operator declared", async () => {
    const output = await outputDirectory();
    const handler = productionHandler();
    const { baseUrl } = mockServer(async (incoming) => {
      const reply = handler(incoming);
      if (!new URL(incoming.url).pathname.endsWith("/generate-exercise/status")) return reply;
      if (reply.status !== 200) return reply;
      const body = (await reply.json()) as Record<string, unknown>;
      return json({ ...body, limits: { max_job_duration_ms: 1_800_000, max_turns: 60 } });
    });

    const result = await new ArtemisGenerator(
      request(output, baseUrl, {
        server_limits: { max_job_duration_ms: 2_700_000, max_tokens_per_job: 3_000_000 },
      }),
      output,
    ).generate(new AbortController().signal);

    expect((result.extensions.artemis as { effective_limits: unknown[] }).effective_limits).toEqual(
      [
        { id: "max_job_duration_ms", source: "system_reported", value: 1_800_000 },
        { id: "max_tokens_per_job", source: "system_configured", value: 3_000_000 },
        { id: "max_turns", source: "system_reported", value: 60 },
        { id: "context_window_tokens", source: "unknown" },
        { id: "admission_max_tokens_per_user", source: "unknown" },
      ],
    );
    expect(result.execution?.effective_limits).toEqual({
      wall_time_ms: { value: 1_800_000, source: "system_reported" },
      total_tokens: { value: 3_000_000, source: "system_configured" },
    });
  });
});

describe("Artemis command-line interface", () => {
  test("describe emits a descriptor the protocol accepts, with a valid Draft 2020-12 schema", async () => {
    const { exitCode, stdout, stderr } = await runAdapterCli(["describe", "--json"]);

    expect(exitCode, stderr).toBe(0);
    const descriptor = generatorDescriptorSchema.parse(JSON.parse(stdout));
    expect(descriptor).toMatchObject({
      kind: "generator",
      id: "artemis",
      runtime: { name: "bun" },
    });

    const schema = descriptor.parameters_schema;
    if (schema === undefined) throw new Error("descriptor omitted parameters_schema");
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(() => ajv.compile(schema)).not.toThrow();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(Object.keys(schema.properties as Record<string, unknown>)).toContain("base_url");
  });

  test("describe honours the runtime-configurable adapter id", async () => {
    const { stdout } = await runCli(
      (argv) => runArtemisAdapter({ ...DESCRIPTOR, id: "artemis-approach-a" }, argv),
      ["describe", "--json"],
    );

    expect(JSON.parse(stdout).id).toBe("artemis-approach-a");
  });

  test("generate refuses a request whose output_dir disagrees with --output", async () => {
    const output = await outputDirectory();
    const requestPath = join(output, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify(request(join(output, "elsewhere"), "https://artemis.example.edu")),
    );

    const { exitCode, stderr } = await runAdapterCli([
      "generate",
      "--request",
      requestPath,
      "--output",
      output,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("output_dir does not match --output");
  });

  test("generate runs the attempt and writes a protocol-valid response.json", async () => {
    const output = await outputDirectory();
    const { baseUrl } = mockServer(productionHandler());
    const requestPath = join(output, "request.json");
    await writeFile(requestPath, JSON.stringify(request(output, baseUrl)));

    const { exitCode, stderr } = await runAdapterCli([
      "generate",
      "--request",
      requestPath,
      "--output",
      output,
    ]);

    expect(exitCode, stderr).toBe(0);
    const response = generationResponseSchema.parse(
      JSON.parse(await readFile(join(output, "response.json"), "utf8")),
    );
    expect(response.status).toBe("succeeded");
    expect(response.extensions.artemis).toMatchObject({ exercise_id: 44, job_id: "job-1" });
  });

  test("recover cancels the recorded job and writes no response", async () => {
    const output = await outputDirectory();
    await writeState(output, {
      schema_version: "3",
      attempt_id: "temperature-case-system-a-r1",
      course_id: 123,
      short_name: SHORT_NAME,
      phase: "generation_started",
      exercise_id: 44,
      job_id: "job-existing",
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    let cancelled = false;
    const { baseUrl, recorded } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname.endsWith("/generate-exercise/status"))
        return json({
          jobId: "job-existing",
          running: !cancelled,
          mode: "GENERATE",
          ownedByCaller: true,
          events: cancelled
            ? [started, { type: "CANCELLED", message: "c", timestamp: "2026-07-31T10:01:00Z" }]
            : [started],
          fileChanges: [],
          accountingState: cancelled ? "COMPLETE" : "PENDING",
          ...(cancelled ? { usage: usage() } : {}),
        });
      if (incoming.method === "DELETE" && url.pathname.endsWith("/jobs/job-existing")) {
        cancelled = true;
        return new Response(null, { status: 200 });
      }
      return json({ error: "unexpected" }, 500);
    });
    const requestPath = join(output, "request.json");
    await writeFile(requestPath, JSON.stringify(request(output, baseUrl)));

    const { exitCode, stderr } = await runAdapterCli([
      "recover",
      "--request",
      requestPath,
      "--output",
      output,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(
      recorded.filter((entry) => entry.method === "DELETE" && entry.path.includes("/jobs/")),
    ).toHaveLength(1);
    expect(startedGeneration(recorded)).toHaveLength(0);
    expect(await Bun.file(join(output, "response.json")).exists()).toBe(false);
  });

  test("the adapter prints usage and succeeds when given no arguments", async () => {
    const { exitCode, stdout, stderr } = await runAdapterCli([]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("Usage: artemis");
    expect(stdout).toContain("describe");
    expect(stdout).toContain("generate");
    expect(stdout).toContain("recover");
  });

  test("campaign prints usage to stdout and succeeds when given no arguments", async () => {
    const { exitCode, stdout, stderr } = await runCampaignCli([]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("Usage: artemis-campaign");
    for (const command of ["environment", "preflight", "cleanup"])
      expect(stdout).toContain(command);
  });

  test("campaign environment renders the map through the CLI", async () => {
    const output = await outputDirectory();
    const parametersPath = join(output, "parameters.json");
    await writeFile(
      parametersPath,
      JSON.stringify({
        base_url: "https://artemis.example.edu",
        auth: { type: "bearer", token_env: "ARTEMIS_TEST_USER" },
        course_id: 123,
        telemetry: {
          provider: "opentelemetry",
          traces_path_env: "ARTEMIS_ADAPTER_TEST_OTEL_PATH",
          artemis_otlp_endpoint: "http://exgen-otel:4318/v1/traces",
          content_capture: "required",
        },
      }),
    );

    const { exitCode, stdout, stderr } = await runCampaignCli([
      "environment",
      "--parameters",
      parametersPath,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(
      benchmarkEnvironment(
        artemisParametersSchema.parse(JSON.parse(await readFile(parametersPath, "utf8")))
          .telemetry as NonNullable<ArtemisParameters["telemetry"]>,
      ),
    );
  });

  test("campaign environment refuses parameters that configure no telemetry", async () => {
    const output = await outputDirectory();
    const parametersPath = join(output, "parameters.json");
    await writeFile(
      parametersPath,
      JSON.stringify({
        base_url: "https://artemis.example.edu",
        auth: { type: "bearer", token_env: "ARTEMIS_TEST_USER" },
        course_id: 123,
      }),
    );

    const { exitCode, stderr } = await runCampaignCli([
      "environment",
      "--parameters",
      parametersPath,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("require OpenTelemetry capture");
  });

  test("campaign preflight fails with a clear message when the course is not listable", async () => {
    const output = await outputDirectory();
    const tracesPath = join(output, "collector-traces.jsonl");
    await writeFile(tracesPath, "");
    process.env.ARTEMIS_ADAPTER_TEST_OTEL_PATH = tracesPath;
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises")
        return json({ title: "You are not allowed to access this resource" }, 200);
      return json({ error: "unexpected" }, 500);
    });
    const parametersPath = join(output, "parameters.json");
    await writeFile(
      parametersPath,
      JSON.stringify({
        base_url: baseUrl,
        auth: {
          type: "password",
          username_env: "ARTEMIS_TEST_USER",
          password_env: "ARTEMIS_TEST_PASSWORD",
        },
        course_id: 123,
        telemetry: {
          provider: "opentelemetry",
          traces_path_env: "ARTEMIS_ADAPTER_TEST_OTEL_PATH",
          artemis_otlp_endpoint: "http://127.0.0.1:4318/v1/traces",
          content_capture: "required",
        },
      }),
    );

    const { exitCode, stderr } = await runCampaignCli([
      "preflight",
      "--parameters",
      parametersPath,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("configured Artemis course is not accessible");
  });

  async function preflightAgainst(
    output: string,
    languages: unknown,
    format?: Record<string, unknown>,
  ): Promise<CliResult & { tracesPath: string }> {
    const tracesPath = join(output, "collector-traces.jsonl");
    await writeFile(tracesPath, "");
    process.env.ARTEMIS_ADAPTER_TEST_OTEL_PATH = tracesPath;
    const { baseUrl } = mockServer(async (incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=t; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises")
        return json([{ id: 7, shortName: "existing" }]);
      if (url.pathname.endsWith("/generation/effort-profiles"))
        return json([
          { name: "draft", label: "Quick draft" },
          { name: "standard", label: "Standard" },
        ]);
      if (url.pathname.endsWith("/generation/supported-languages")) {
        await writeFile(tracesPath, telemetryExport("preflight-job"));
        return json(languages);
      }
      return json({ error: "unexpected" }, 500);
    });
    const parametersPath = join(output, "parameters.json");
    await writeFile(
      parametersPath,
      JSON.stringify({
        base_url: baseUrl,
        auth: {
          type: "password",
          username_env: "ARTEMIS_TEST_USER",
          password_env: "ARTEMIS_TEST_PASSWORD",
        },
        course_id: 123,
        telemetry: {
          provider: "opentelemetry",
          traces_path_env: "ARTEMIS_ADAPTER_TEST_OTEL_PATH",
          artemis_otlp_endpoint: "http://127.0.0.1:4318/v1/traces",
          content_capture: "required",
          timeout_ms: 2_000,
          poll_interval_ms: 1,
        },
      }),
    );
    const formatPath = join(output, "target-parameters.json");
    if (format) await writeFile(formatPath, JSON.stringify(format));
    const result = await runCampaignCli([
      "preflight",
      "--parameters",
      parametersPath,
      ...(format ? ["--target-parameters", formatPath] : []),
    ]);
    return { ...result, tracesPath };
  }

  test("preflight reports course access, Java support, and live collector output", async () => {
    const output = await outputDirectory();

    const { exitCode, stdout, stderr } = await preflightAgainst(output, ["JAVA", "KOTLIN"]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      course_id: 123,
      existing_exercises: 1,
      generation_language: "JAVA",
      project_type: "PLAIN_MAVEN",
      effort_profiles: ["draft", "standard"],
    });
    const telemetry = JSON.parse(stdout).opentelemetry;
    expect(telemetry.exported_spans).toBeGreaterThan(0);
    expect(telemetry.verified).toBe("model_span_decoded");
    expect(telemetry.decoded_model_spans).toBeGreaterThan(0);
  });

  test("preflight fails when Hyperion does not advertise Java generation", async () => {
    const output = await outputDirectory();

    const { exitCode, stderr } = await preflightAgainst(output, ["PYTHON"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not support Hyperion JAVA generation");
  });

  test("preflight checks the configured language rather than always checking Java", async () => {
    const passes = await preflightAgainst(await outputDirectory(), ["JAVA", "PYTHON"], {
      language: "python",
      project_type: null,
    });
    expect(passes.exitCode, passes.stderr).toBe(0);
    expect(JSON.parse(passes.stdout)).toMatchObject({ generation_language: "PYTHON" });

    const fails = await preflightAgainst(await outputDirectory(), ["JAVA"], {
      language: "python",
      project_type: null,
    });
    expect(fails.exitCode).toBe(1);
    expect(fails.stderr).toContain("does not support Hyperion PYTHON generation");
  });

  test("cliPath refuses a value that is another option", () => {
    expect(cliPath("/tmp/parameters.json")).toBe("/tmp/parameters.json");
    expect(cliPath("relative/path.json")).toBe("relative/path.json");
    for (const value of ["--run-dir", "-r", "--"])
      expect(() => cliPath(value)).toThrow("expected a path");
  });

  test("cliPositiveInteger refuses everything that is not a positive integer", () => {
    expect(cliPositiveInteger("123")).toBe(123);
    expect(cliPositiveInteger("1")).toBe(1);
    for (const value of ["0", "-1", "1.5", "course-123", "", "NaN", "Infinity", "1e400"])
      expect(() => cliPositiveInteger(value), value).toThrow("expected a positive integer");
  });
});

describe("Artemis instructor export handling", () => {
  function patchCentral(
    bytes: Uint8Array,
    index: number,
    patch: (view: DataView, offset: number) => void,
  ): Uint8Array {
    const copy = new Uint8Array(bytes);
    const view = new DataView(copy.buffer);
    let eocd = -1;
    for (let offset = copy.length - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    let offset = view.getUint32(eocd + 16, true);
    for (let current = 0; current < index; current += 1) {
      offset +=
        46 +
        view.getUint16(offset + 28, true) +
        view.getUint16(offset + 30, true) +
        view.getUint16(offset + 32, true);
    }
    patch(view, offset);
    return copy;
  }

  function patchEocd(
    bytes: Uint8Array,
    patch: (view: DataView, offset: number) => void,
  ): Uint8Array {
    const copy = new Uint8Array(bytes);
    const view = new DataView(copy.buffer);
    for (let offset = copy.length - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        patch(view, offset);
        break;
      }
    }
    return copy;
  }

  const limits = { maxBytes: 1024 * 1024, maxFiles: 100, maxRatio: 200 };
  const sample = zipSync({
    "a.txt": encoder.encode("alpha content that compresses"),
    "b.txt": encoder.encode("beta content that compresses"),
  });

  test("accepts a well-formed instructor export", () => {
    expect(centralEntries(sample, limits).map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
  });

  test("rejects a duplicate declared path", () => {
    const forged = patchCentral(sample, 1, (view, offset) => {
      view.setUint8(offset + 46, "a".charCodeAt(0));
    });
    expect(() => centralEntries(forged, limits)).toThrow("duplicate path: a.txt");
  });

  test("keeps case-distinct paths that a Linux repository may legitimately contain", () => {
    const mixed = zipSync({
      "README.md": encoder.encode("upper"),
      "readme.md": encoder.encode("lower"),
    });
    expect(centralEntries(mixed, limits)).toHaveLength(2);
  });

  test("rejects an encrypted entry", () => {
    const forged = patchCentral(sample, 0, (view, offset) => {
      view.setUint16(offset + 8, 1, true);
    });
    expect(() => centralEntries(forged, limits)).toThrow("unsupported or encrypted entry");
  });

  test("rejects an unsupported compression method", () => {
    const forged = patchCentral(sample, 0, (view, offset) => {
      view.setUint16(offset + 10, 9, true);
    });
    expect(() => centralEntries(forged, limits)).toThrow("unsupported or encrypted entry");
  });

  test("rejects a ZIP64 export before any decompression", () => {
    const forged = patchEocd(sample, (view, offset) => {
      view.setUint32(offset + 12, 0xffffffff, true);
    });
    expect(() => centralEntries(forged, limits)).toThrow("ZIP64");
  });

  test("rejects a symbolic link declared through Unix external attributes", () => {
    const forged = patchCentral(sample, 0, (view, offset) => {
      view.setUint16(offset + 4, 3 << 8, true);
      view.setUint32(offset + 38, 0xa000 << 16, true);
    });
    expect(() => centralEntries(forged, limits)).toThrow("link or special file: a.txt");
  });

  test("rejects an entry that expands beyond the configured ratio", () => {
    const forged = patchCentral(sample, 0, (view, offset) => {
      view.setUint32(offset + 24, 1_000_000, true);
    });
    expect(() => centralEntries(forged, limits)).toThrow("max_archive_ratio");
  });

  test("rejects an export with more files than the configured bound", () => {
    expect(() => centralEntries(sample, { ...limits, maxFiles: 1 })).toThrow("max_archive_files");
  });

  test("rejects an export declaring more bytes than the configured bound", () => {
    expect(() => centralEntries(sample, { ...limits, maxBytes: 10 })).toThrow("max_artifact_bytes");
  });

  test("rejects a central directory whose declared size does not match its records", () => {
    const forged = patchEocd(sample, (view, offset) => {
      view.setUint32(offset + 12, view.getUint32(offset + 12, true) - 1, true);
    });
    expect(() => centralEntries(forged, limits)).toThrow("central directory size is inconsistent");
  });
});

describe("Artemis exported repository verification", () => {
  test("accepts repositories whose HEAD commit object resolves to the recorded commit", async () => {
    const output = await outputDirectory();
    for (const role of ROLES) {
      await extractInto(join(output, "artifacts", role), repositories[role].zip);
    }
    await expect(verifyExportedRepositoryCommits(output, commits)).resolves.toBeUndefined();
  });

  test("names both commits when an export points at a different commit", async () => {
    const output = await outputDirectory();
    for (const role of ROLES) {
      await extractInto(join(output, "artifacts", role), repositories[role].zip);
    }
    await expect(
      verifyExportedRepositoryCommits(output, { ...commits, tests: "d".repeat(40) }),
    ).rejects.toThrow(`expected ${"d".repeat(40)}, observed ${commits.tests}`);
  });

  test("rejects a repository whose HEAD names an object that is not present", async () => {
    const output = await outputDirectory();
    for (const role of ROLES) {
      const root = join(output, "artifacts", role, ".git");
      await mkdir(join(root, "refs", "heads"), { recursive: true });
      await mkdir(join(root, "objects"), { recursive: true });
      await writeFile(join(root, "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(root, "refs", "heads", "main"), `${commits[role]}\n`);
      await writeFile(join(root, "config"), "[core]\n\trepositoryformatversion = 0\n");
    }
    await expect(verifyExportedRepositoryCommits(output, commits)).rejects.toThrow(
      "could not resolve the exported",
    );
  });
});

describe("Artemis campaign cleanup", () => {
  async function runCleanup(
    output: string,
    baseUrl: string,
    extra: string[] = [],
    confirmCourseId = "123",
  ): Promise<CliResult> {
    const parametersPath = join(output, "parameters.json");
    await writeFile(
      parametersPath,
      JSON.stringify({
        base_url: baseUrl,
        auth: {
          type: "password",
          username_env: "ARTEMIS_TEST_USER",
          password_env: "ARTEMIS_TEST_PASSWORD",
        },
        course_id: 123,
      }),
    );
    return await runCampaignCli([
      "cleanup",
      "--parameters",
      parametersPath,
      "--run-dir",
      output,
      "--confirm-course-id",
      confirmCourseId,
      ...extra,
    ]);
  }

  function cleanupServer(listed: Array<Record<string, unknown>>, failDelete = false) {
    const deleted: string[] = [];
    const { baseUrl } = mockServer((incoming) => {
      const url = new URL(incoming.url);
      if (url.pathname === "/api/core/public/authenticate")
        return json({}, 200, { "set-cookie": "jwt=cleanup-token; Path=/; HttpOnly" });
      if (url.pathname === "/api/programming/courses/123/programming-exercises")
        return json(listed);
      if (incoming.method === "DELETE") {
        deleted.push(`${url.pathname}${url.search}`);
        if (failDelete) return json({ error: "bad gateway" }, 502);
        return new Response(null, { status: 200 });
      }
      return json({ error: "unexpected" }, 500);
    });
    return { baseUrl, deleted };
  }

  async function writeLedger(
    output: string,
    attempt: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(join(output, attempt, "artemis"), { recursive: true });
    await writeFile(
      join(output, attempt, "artemis", "adapter-state.json"),
      JSON.stringify({
        schema_version: "3",
        attempt_id: attempt,
        course_id: 123,
        phase: "terminal",
        job_id: `job-${attempt}`,
        deadline_at: "2026-08-01T00:00:00Z",
        telemetry_cursor_bytes: 0,
        terminal_version_id: 77,
        ...state,
      }),
    );
  }

  test("deletes only ledger-owned exercises in the confirmed course", async () => {
    const output = await outputDirectory();
    await writeLedger(output, "attempt-1", { exercise_id: 44, short_name: "exgenowned" });
    const { baseUrl, deleted } = cleanupServer([
      { id: 44, shortName: "exgenowned" },
      { id: 45, shortName: "exgennotowned" },
    ]);

    const { exitCode, stdout, stderr } = await runCleanup(output, baseUrl);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      course_id: 123,
      ledger_owned: 1,
      deleted: 1,
      failed: 0,
      dry_run: false,
      results: [{ exercise_id: 44, short_name: "exgenowned", outcome: "deleted" }],
    });
    expect(deleted).toEqual([
      "/api/programming/programming-exercises/44?deleteStudentReposBuildPlans=true&deleteBaseReposBuildPlans=true",
    ]);
  });

  test("deletes nothing when the confirmation course does not match the parameters", async () => {
    const output = await outputDirectory();
    await writeLedger(output, "attempt-1", { exercise_id: 44, short_name: "exgenowned" });
    const { baseUrl, deleted } = cleanupServer([{ id: 44, shortName: "exgenowned" }]);

    const { exitCode, stderr } = await runCleanup(output, baseUrl, [], "124");

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--confirm-course-id must exactly match");
    expect(deleted).toEqual([]);
  });

  test("deletes nothing when the remote short name no longer matches the ledger", async () => {
    const output = await outputDirectory();
    await writeLedger(output, "attempt-1", { exercise_id: 44, short_name: "exgenowned" });
    const { baseUrl, deleted } = cleanupServer([{ id: 44, shortName: "exgenrenamed" }]);

    const { exitCode, stdout, stderr } = await runCleanup(output, baseUrl);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ledger_owned: 1, deleted: 0, results: [] });
    expect(deleted).toEqual([]);
  });

  test("ignores adapter state that the generator itself would refuse to read", async () => {
    const output = await outputDirectory();
    await mkdir(join(output, "attempt-1", "artemis"), { recursive: true });
    await writeFile(
      join(output, "attempt-1", "artemis", "adapter-state.json"),
      JSON.stringify({
        schema_version: "3",
        course_id: 123,
        exercise_id: 44,
        short_name: "exgenowned",
      }),
    );
    const { baseUrl, deleted } = cleanupServer([{ id: 44, shortName: "exgenowned" }]);

    const { exitCode, stdout, stderr } = await runCleanup(output, baseUrl);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ledger_owned: 0,
      deleted: 0,
      unreadable_state_files: ["attempt-1/artemis/adapter-state.json"],
    });
    expect(deleted).toEqual([]);
  });

  test("reports an unreadable state file rather than aborting the whole cleanup", async () => {
    const output = await outputDirectory();
    await writeLedger(output, "attempt-1", { exercise_id: 44, short_name: "exgenowned" });
    await mkdir(join(output, "attempt-2", "artemis"), { recursive: true });
    await writeFile(
      join(output, "attempt-2", "artemis", "adapter-state.json"),
      '{"schema_version":"3","exercise_i',
    );
    const { baseUrl, deleted } = cleanupServer([{ id: 44, shortName: "exgenowned" }]);

    const { exitCode, stdout, stderr } = await runCleanup(output, baseUrl);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ledger_owned: 1,
      deleted: 1,
      unreadable_state_files: ["attempt-2/artemis/adapter-state.json"],
    });
    expect(deleted).toHaveLength(1);
  });

  test("reports every exercise it would delete without deleting anything", async () => {
    const output = await outputDirectory();
    await writeLedger(output, "attempt-1", { exercise_id: 44, short_name: "exgenowned" });
    const { baseUrl, deleted } = cleanupServer([{ id: 44, shortName: "exgenowned" }]);

    const { exitCode, stdout, stderr } = await runCleanup(output, baseUrl, ["--dry-run"]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      dry_run: true,
      deleted: 0,
      results: [{ exercise_id: 44, outcome: "skipped" }],
    });
    expect(deleted).toEqual([]);
  });

  test("continues past a failed deletion and still reports the full outcome", async () => {
    const output = await outputDirectory();
    await writeLedger(output, "attempt-1", { exercise_id: 44, short_name: "exgenone" });
    await writeLedger(output, "attempt-2", { exercise_id: 45, short_name: "exgentwo" });
    const { baseUrl, deleted } = cleanupServer(
      [
        { id: 44, shortName: "exgenone" },
        { id: 45, shortName: "exgentwo" },
      ],
      true,
    );

    const { exitCode, stdout } = await runCleanup(output, baseUrl);

    expect(exitCode).toBe(1);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({ ledger_owned: 2, deleted: 0, failed: 2 });
    expect(summary.results).toHaveLength(2);
    expect(deleted).toHaveLength(2);
  });
});
