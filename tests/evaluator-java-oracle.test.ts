import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { EvaluationRequest } from "../src/evaluation/contracts.ts";
import {
  buildOutcomeSchema,
  passRate,
  type BuildOutcome,
} from "../evaluators/java-oracle/backend.ts";
import {
  assembleScores,
  createOracleEvaluator,
  oracleVerdict,
} from "../evaluators/java-oracle/evaluate.ts";
import { FixtureBuildBackend } from "../evaluators/java-oracle/fixture-backend.ts";
import {
  LocalCiBuildBackend,
  localCiBackendConfigSchema,
  toSubmissionBuild,
  type LocalCiFetch,
} from "../evaluators/java-oracle/localci-backend.ts";
import {
  configDigestFromArgv,
  configPathFromArgv,
  createBackend,
  FIXTURE_BACKEND_OPT_IN,
  fixtureBackendAllowedByArgv,
  loadWorkerConfig,
  resolveBackendConfig,
  workerConfigDigest,
} from "../evaluators/java-oracle/worker.ts";
import { runEvaluation } from "../evaluators/shared/protocol.ts";

const FIXTURES = resolve(import.meta.dir, "../evaluators/fixtures");

function outcome(
  template: Partial<BuildOutcome["template"]>,
  solution: Partial<BuildOutcome["solution"]>,
): BuildOutcome {
  return buildOutcomeSchema.parse({
    template: { compiled: true, tests_executed: true, test_cases: [], ...template },
    solution: { compiled: true, tests_executed: true, test_cases: [], ...solution },
    attestation: { backend_id: "test" },
  });
}

function cases(passed: number, failed: number) {
  return [
    ...Array.from({ length: passed }, (_, index) => ({ name: `pass-${index}`, passed: true })),
    ...Array.from({ length: failed }, (_, index) => ({ name: `fail-${index}`, passed: false })),
  ];
}

describe("the acceptance gate", () => {
  test("is satisfied only when the solution passes everything and the template passes nothing", () => {
    expect(
      oracleVerdict(outcome({ test_cases: cases(0, 3) }, { test_cases: cases(3, 0) })).satisfied,
    ).toBe(true);
  });

  test("rejects a template that passes any test", () => {
    const verdict = oracleVerdict(
      outcome({ test_cases: cases(1, 2) }, { test_cases: cases(3, 0) }),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("template already passes 1 of 3");
  });

  test("rejects a solution that fails any test", () => {
    const verdict = oracleVerdict(
      outcome({ test_cases: cases(0, 3) }, { test_cases: cases(2, 1) }),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("passes 2 of 3 tests");
  });

  test("rejects an exercise with no test cases at all", () => {
    const verdict = oracleVerdict(outcome({}, {}));
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons).toContain("the exercise declares no test cases");
  });

  test("rejects a build that did not compile or did not run", () => {
    expect(oracleVerdict(outcome({}, { compiled: false })).reasons).toContain(
      "the solution does not compile",
    );
    expect(oracleVerdict(outcome({ tests_executed: false }, {})).reasons).toContain(
      "the test suite did not run against the template",
    );
  });

  test("coverage and mutation are never part of the gate", () => {
    const withoutCoverage = outcome({ test_cases: cases(0, 3) }, { test_cases: cases(3, 0) });
    const withPoorCoverage = outcome(
      { test_cases: cases(0, 3) },
      { test_cases: cases(3, 0), coverage: { statement: 0.01, branch: 0 } },
    );
    expect(oracleVerdict(withoutCoverage).satisfied).toBe(true);
    expect(oracleVerdict(withPoorCoverage).satisfied).toBe(true);
    const scores = assembleScores(withPoorCoverage, oracleVerdict(withPoorCoverage));
    expect(scores.find((score) => score.metric_id === "coverage.statement")?.value).toBe(0.01);
    expect(scores.find((score) => score.metric_id === "mutation.score")?.status).toBe(
      "not_applicable",
    );
  });

  test("pass rates carry their numerator and denominator", () => {
    const build = outcome({}, { test_cases: cases(2, 1) }).solution;
    expect(passRate(build)).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3 });
    const score = assembleScores(
      outcome({ test_cases: cases(0, 3) }, { test_cases: cases(2, 1) }),
      { satisfied: false, reasons: ["x"] },
    ).find((entry) => entry.metric_id === "oracle.solution_pass_rate");
    expect(score?.numerator).toBe(2);
    expect(score?.denominator).toBe(3);
  });
});

describe("fixture backend", () => {
  test("replays a recorded build outcome", async () => {
    const backend = new FixtureBuildBackend(resolve(FIXTURES, "oracle-recordings"));
    const result = await backend.build({
      request: { candidate: { case_id: "correct-exercise" } } as EvaluationRequest,
      bundle: {} as never,
    });
    expect(result.solution.test_cases).toHaveLength(3);
    expect(result.attestation.unattested).toContain("artemis_revision");
  });

  test("replays a recorded infrastructure failure as an infrastructure failure", async () => {
    const backend = new FixtureBuildBackend(resolve(FIXTURES, "oracle-recordings"));
    await expect(
      backend.build({
        request: { candidate: { case_id: "non-terminating-test" } } as EvaluationRequest,
        bundle: {} as never,
      }),
    ).rejects.toThrow(/build timeout/);
  });

  test("a missing recording is infrastructure, not a verdict", async () => {
    const backend = new FixtureBuildBackend(resolve(FIXTURES, "oracle-recordings"));
    await expect(
      backend.build({
        request: { candidate: { case_id: "no-such-case" } } as EvaluationRequest,
        bundle: {} as never,
      }),
    ).rejects.toThrow(/no recorded build result/);
  });
});

describe("LocalCI backend configuration", () => {
  const base = {
    kind: "localci" as const,
    base_url: "https://artemis.test",
    evaluation_course_id: 7,
  };

  test("refuses an evaluation course that is also a generation course", () => {
    expect(() =>
      localCiBackendConfigSchema.parse({ ...base, generation_course_ids: [7, 9] }),
    ).toThrow(/must differ from every generation course/);
    expect(
      localCiBackendConfigSchema.parse({ ...base, generation_course_ids: [9] })
        .evaluation_course_id,
    ).toBe(7);
  });

  test("carries overridable endpoint templates so Phase 2 reconciliation is configuration", () => {
    const config = localCiBackendConfigSchema.parse(base);
    expect(config.endpoints.trigger_builds).toContain("trigger-instructor-build-all");
    const overridden = localCiBackendConfigSchema.parse({
      ...base,
      endpoints: { trigger_builds: "/custom/{exerciseId}/build" },
    });
    expect(overridden.endpoints.trigger_builds).toBe("/custom/{exerciseId}/build");
    // Everything not overridden keeps its default, so a partial override is safe.
    expect(overridden.endpoints.commit_repository).toBe(config.endpoints.commit_repository);
  });
});

describe("LocalCI result mapping", () => {
  test("maps feedbacks onto test cases and non-test feedback onto diagnostics", () => {
    const build = toSubmissionBuild({
      id: 1,
      completionDate: "2026-08-06T00:00:00Z",
      feedbacks: [
        { testCase: { testName: "sumsEvenValues" }, positive: true },
        { testCase: { testName: "handlesNegatives" }, positive: false, detailText: "expected -6" },
        { text: "Compilation warning: unused import" },
      ],
      submission: { buildFailed: false },
    });
    expect(build.compiled).toBe(true);
    expect(build.tests_executed).toBe(true);
    expect(build.test_cases).toEqual([
      { name: "sumsEvenValues", passed: true },
      { name: "handlesNegatives", passed: false, message: "expected -6" },
    ]);
    expect(build.diagnostics).toEqual(["Compilation warning: unused import"]);
  });

  test("a failed build reports no executed tests rather than a zero pass rate", () => {
    const build = toSubmissionBuild({
      id: 2,
      completionDate: "2026-08-06T00:00:00Z",
      feedbacks: [],
      submission: { buildFailed: true },
    });
    expect(build.compiled).toBe(false);
    expect(build.tests_executed).toBe(false);
    expect(passRate(build).rate).toBeNull();
  });

  test("a compiled build with no test cases is not treated as an executed suite", () => {
    const build = toSubmissionBuild({
      id: 3,
      completionDate: "2026-08-06T00:00:00Z",
      feedbacks: [],
      submission: { buildFailed: false },
    });
    expect(build.compiled).toBe(true);
    expect(build.tests_executed).toBe(false);
  });

  test("aggregates JaCoCo line coverage and reports branch coverage as unavailable", () => {
    const build = toSubmissionBuild({
      id: 4,
      completionDate: "2026-08-06T00:00:00Z",
      feedbacks: [{ testCase: { testName: "t" }, positive: true }],
      coverageFileReportsByTestCaseName: {
        "EvenSum.java": { coveredLineCount: 8, missedLineCount: 2 },
      },
    } as never);
    expect(build.coverage?.statement).toBeCloseTo(0.8, 12);
    expect(build.coverage?.branch).toBeNull();
  });
});

describe("LocalCI build flow", () => {
  const config = localCiBackendConfigSchema.parse({
    kind: "localci",
    base_url: "https://artemis.test",
    evaluation_course_id: 7,
    poll_interval_ms: 250,
    build_timeout_ms: 60_000,
  });

  const bundle = {
    root: "/bundle",
    statement: "# Even Sum",
    statementPath: "problem-statement.md",
    template: [{ path: "src/A.java", content: "class A {}", bytes: 10 }],
    solution: [{ path: "src/A.java", content: "class A { int f() { return 1; } }", bytes: 33 }],
    tests: [{ path: "src/ATest.java", content: "class ATest {}", bytes: 14 }],
  };

  function job(): { request: EvaluationRequest; bundle: typeof bundle } {
    return {
      request: {
        evaluation_id: "f".repeat(64),
        candidate: { case_id: "case-1" },
      } as EvaluationRequest,
      bundle,
    };
  }

  function recordedFetch(script: Array<{ match: RegExp; status?: number; body: unknown }>): {
    fetchImplementation: LocalCiFetch;
    calls: Array<{ method: string; url: string; body: string | undefined }>;
  } {
    const calls: Array<{ method: string; url: string; body: string | undefined }> = [];
    const fetchImplementation: LocalCiFetch = async (url, init) => {
      calls.push({ method: init.method, url, body: init.body });
      const entry = script.find((candidate) => candidate.match.test(url));
      if (entry === undefined) {
        return { status: 404, text: async () => "" };
      }
      return { status: entry.status ?? 200, text: async () => JSON.stringify(entry.body) };
    };
    return { fetchImplementation, calls };
  }

  const exercise = {
    id: 42,
    shortName: `exgeneval${"f".repeat(10)}`,
    templateParticipation: { id: 100 },
    solutionParticipation: { id: 200 },
  };

  test("creates an exercise, pushes only candidate content, triggers and collects both builds", async () => {
    const { fetchImplementation, calls } = recordedFetch([
      { match: /courses\/7\/programming-exercises/, body: [] },
      { match: /programming-exercises\/setup/, body: exercise },
      { match: /repository\/\d+\/file/, body: {} },
      { match: /repository\/\d+\/commit/, body: {} },
      { match: /trigger-instructor-build-all/, body: {} },
      {
        match: /participations\/100\/results/,
        body: [
          {
            id: 1,
            completionDate: "2026-08-06T00:00:00Z",
            feedbacks: [{ testCase: { testName: "t" }, positive: false }],
            submission: { buildFailed: false },
          },
        ],
      },
      {
        match: /participations\/200\/results/,
        body: [
          {
            id: 2,
            completionDate: "2026-08-06T00:00:00Z",
            feedbacks: [{ testCase: { testName: "t" }, positive: true }],
            submission: { buildFailed: false },
          },
        ],
      },
      { match: /programming-exercises\/42\?/, body: {} },
    ]);
    const backend = new LocalCiBuildBackend({
      config,
      authorization: "Bearer secret",
      fetchImplementation,
      sleep: async () => undefined,
    });
    const result = await backend.build(job() as never, new AbortController().signal);

    expect(oracleVerdict(result).satisfied).toBe(true);
    expect(result.attestation.backend_id).toBe("localci");
    expect(result.attestation.artemis_revision).toBeNull();

    // The exercise is created unreleased, in the evaluation course, and removed afterwards.
    const setup = calls.find((call) => call.url.includes("setup"));
    expect(JSON.parse(setup?.body ?? "{}")).toMatchObject({
      course: { id: 7 },
      releaseDate: null,
    });
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/42?"))).toBe(true);

    // Only content the candidate itself produced crossed the boundary.
    const pushed = calls
      .filter((call) => call.url.includes("/file"))
      .map((call) => JSON.parse(call.body ?? "{}").content as string);
    expect(pushed).toHaveLength(3);
    expect(pushed.join("\n")).not.toContain("golden");
  });

  test("polls until a result completes", async () => {
    let solutionPolls = 0;
    const fetchImplementation: LocalCiFetch = async (url, init) => {
      const json = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });
      if (/courses\/7\/programming-exercises/.test(url) && init.method === "GET") return json([]);
      if (url.includes("setup")) return json(exercise);
      if (/participations\/200\/results/.test(url)) {
        solutionPolls += 1;
        return json(
          solutionPolls < 3
            ? [{ id: 9 }]
            : [
                {
                  id: 9,
                  completionDate: "2026-08-06T00:00:00Z",
                  feedbacks: [{ testCase: { testName: "t" }, positive: true }],
                  submission: { buildFailed: false },
                },
              ],
        );
      }
      if (/participations\/100\/results/.test(url)) {
        return json([
          {
            id: 8,
            completionDate: "2026-08-06T00:00:00Z",
            feedbacks: [{ testCase: { testName: "t" }, positive: false }],
            submission: { buildFailed: false },
          },
        ]);
      }
      return json({});
    };
    const backend = new LocalCiBuildBackend({
      config,
      authorization: "Bearer secret",
      fetchImplementation,
      sleep: async () => undefined,
    });
    const result = await backend.build(job() as never, new AbortController().signal);
    expect(solutionPolls).toBe(3);
    expect(result.solution.test_cases).toHaveLength(1);
  });

  test("a build that never completes is an infrastructure timeout, not a failing exercise", async () => {
    let clock = 0;
    const fetchImplementation: LocalCiFetch = async (url, init) => {
      const json = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });
      if (/courses\/7\/programming-exercises/.test(url) && init.method === "GET") return json([]);
      if (url.includes("setup")) return json(exercise);
      if (url.includes("/results")) return json([{ id: 1 }]);
      return json({});
    };
    const backend = new LocalCiBuildBackend({
      config,
      authorization: "Bearer secret",
      fetchImplementation,
      sleep: async () => {
        clock += 30_000;
      },
      now: () => clock,
    });
    await expect(backend.build(job() as never, new AbortController().signal)).rejects.toThrow(
      /within the build timeout/,
    );
  });

  test("an HTTP failure never becomes a quality verdict", async () => {
    const fetchImplementation: LocalCiFetch = async () => ({
      status: 503,
      text: async () => "unavailable",
    });
    const backend = new LocalCiBuildBackend({
      config,
      authorization: "Bearer secret",
      fetchImplementation,
      sleep: async () => undefined,
    });
    const request = {
      protocol_version: "1" as const,
      evaluation_id: "e".repeat(64),
      candidate: {
        experiment_id: "x",
        attempt_id: "a",
        generation_key: "a".repeat(64),
        case_id: "correct-exercise",
        system_id: "s",
        replicate: 1,
        artifact_digest: "b".repeat(64),
        bundle_path: resolve(FIXTURES, "correct-exercise/bundle"),
      },
      evaluator: {
        id: "java-oracle",
        version: "1",
        revision: "r",
        target_profile: "artemis-java-maven",
        implementation_digest: "c".repeat(64),
      },
      suite: { id: "s", version: "1", digest: "d".repeat(64) },
      requested_metrics: [],
    };
    const response = await runEvaluation(request, createOracleEvaluator(backend));
    expect(response.status).toBe("infra_failed");
    expect(response.strict_success).toBeNull();
  });

  test("recovery removes an orphaned exercise so a replay can address the same one", async () => {
    const { fetchImplementation, calls } = recordedFetch([
      { match: /courses\/7\/programming-exercises/, body: [exercise] },
      { match: /programming-exercises\/42\?/, body: {} },
    ]);
    const backend = new LocalCiBuildBackend({
      config,
      authorization: "Bearer secret",
      fetchImplementation,
      sleep: async () => undefined,
    });
    await backend.recover(job() as never, new AbortController().signal);
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/42?"))).toBe(true);
  });

  test("the credential never appears in a URL", async () => {
    const { fetchImplementation, calls } = recordedFetch([
      { match: /courses\/7\/programming-exercises/, body: [] },
      { match: /programming-exercises\/setup/, body: exercise },
      {
        match: /results/,
        body: [
          {
            id: 1,
            completionDate: "2026-08-06T00:00:00Z",
            feedbacks: [{ testCase: { testName: "t" }, positive: true }],
            submission: { buildFailed: false },
          },
        ],
      },
    ]);
    const backend = new LocalCiBuildBackend({
      config,
      authorization: "Bearer super-secret-token",
      fetchImplementation,
      sleep: async () => undefined,
    });
    await backend.build(job() as never, new AbortController().signal).catch(() => undefined);
    expect(calls.every((call) => !call.url.includes("super-secret-token"))).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("worker configuration", () => {
  test("loads the checked-in fixture configuration", async () => {
    const { config, directory } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.fixture.yaml"),
    );
    expect(config.backend.kind).toBe("fixture");
    expect(directory).toContain("java-oracle");
  });

  test("loads the checked-in LocalCI configuration template", async () => {
    const { config } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.localci.example.yaml"),
    );
    expect(config.backend.kind).toBe("localci");
    // Only the environment variable *name* is configured, never the credential.
    expect(config.authorization_env).toMatch(/^[A-Z_]+$/);
  });

  test("reads the backend configuration path from argv, so it enters the configuration digest", () => {
    expect(configPathFromArgv(["--config", "config.fixture.yaml"])).toBe("config.fixture.yaml");
    expect(() => configPathFromArgv([])).toThrow(/requires --config/);
    expect(() => configPathFromArgv(["--config"])).toThrow(/requires --config/);
  });

  test("binds backend configuration content into recorded argv", async () => {
    const { config } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.gradle.yaml"),
    );
    if (config.backend.kind !== "gradle") throw new Error("expected Gradle fixture config");
    const digest = workerConfigDigest(config);
    expect(configDigestFromArgv(["--config-digest", digest])).toBe(digest);
    expect(
      workerConfigDigest({ ...config, backend: { ...config.backend, offline: true } }),
    ).not.toBe(digest);
    expect(() => configDigestFromArgv([])).toThrow("requires --config-digest");
  });

  test("resolves host backend state paths against the configuration directory", async () => {
    const directory = resolve(import.meta.dir, "../evaluators/java-oracle");
    const { config } = await loadWorkerConfig(join(directory, "config.gradle.yaml"));
    const backend = resolveBackendConfig(config.backend, directory);
    expect(backend.kind).toBe("gradle");
    if (backend.kind !== "gradle") throw new Error("expected Gradle backend");
    expect(backend.user_home).toBe(resolve(directory, "../../.exgen/gradle-user-home"));
  });

  test("refuses the fixture backend unless it is explicitly opted into", async () => {
    const { config, directory } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.fixture.yaml"),
    );
    // A backend that replays recordings measures nothing, and the journal cannot tell such a run
    // from a live one, so it must not be reachable by pointing --config at the wrong file.
    expect(() => createBackend(config, directory, {})).toThrow(/measures nothing/);
    expect(() => createBackend(config, directory, {}, {})).toThrow(/measures nothing/);
    expect(() => createBackend(config, directory, {}, { allowFixtureBackend: false })).toThrow(
      /measures nothing/,
    );
    // The opt-in is an argv flag, so a run that used it says so in its configuration digest.
    expect(fixtureBackendAllowedByArgv(["--config", "config.fixture.yaml"])).toBe(false);
    expect(fixtureBackendAllowedByArgv(["--config", "x", FIXTURE_BACKEND_OPT_IN])).toBe(true);
  });

  test("selects the fixture backend and resolves its recordings against the configuration", async () => {
    const { config, directory } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.fixture.yaml"),
    );
    const backend = createBackend(config, directory, {}, { allowFixtureBackend: true });
    expect(backend.id).toBe("fixture");
    const result = await backend.build(
      {
        request: { candidate: { case_id: "correct-exercise" } } as EvaluationRequest,
        bundle: {} as never,
      },
      new AbortController().signal,
    );
    expect(result.solution.test_cases).toHaveLength(3);
  });

  test("the LocalCI backend refuses to start without its credential", async () => {
    const { config, directory } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.localci.example.yaml"),
    );
    expect(() => createBackend(config, directory, {})).toThrow(/requires a credential in/);
    expect(() => createBackend(config, directory, { ARTEMIS_AUTHORIZATION: "" })).toThrow(
      /requires a credential in/,
    );
    const backend = createBackend(config, directory, { ARTEMIS_AUTHORIZATION: "Bearer token" });
    expect(backend.id).toBe("localci");
  });
});
