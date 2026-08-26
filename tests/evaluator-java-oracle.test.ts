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
  sessionCookie,
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
    template: {
      compiled: true,
      tests_executed: true,
      test_cases: [],
      ...template,
    },
    solution: {
      compiled: true,
      tests_executed: true,
      test_cases: [],
      ...solution,
    },
    attestation: { backend_id: "test" },
  });
}

function cases(passed: number, failed: number) {
  return [
    ...Array.from({ length: passed }, (_, index) => ({
      name: `pass-${index}`,
      passed: true,
    })),
    ...Array.from({ length: failed }, (_, index) => ({
      name: `fail-${index}`,
      passed: false,
    })),
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
    expect(passRate(build)).toEqual({
      numerator: 2,
      denominator: 3,
      rate: 2 / 3,
    });
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
      request: {
        candidate: { case_id: "correct-exercise" },
      } as EvaluationRequest,
      bundle: {} as never,
    });
    expect(result.solution.test_cases).toHaveLength(3);
    expect(result.attestation.unattested).toContain("artemis_revision");
  });

  test("replays a recorded infrastructure failure as an infrastructure failure", async () => {
    const backend = new FixtureBuildBackend(resolve(FIXTURES, "oracle-recordings"));
    await expect(
      backend.build({
        request: {
          candidate: { case_id: "non-terminating-test" },
        } as EvaluationRequest,
        bundle: {} as never,
      }),
    ).rejects.toThrow(/build timeout/);
  });

  test("a missing recording is infrastructure, not a verdict", async () => {
    const backend = new FixtureBuildBackend(resolve(FIXTURES, "oracle-recordings"));
    await expect(
      backend.build({
        request: {
          candidate: { case_id: "no-such-case" },
        } as EvaluationRequest,
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
      localCiBackendConfigSchema.parse({
        ...base,
        generation_course_ids: [7, 9],
      }),
    ).toThrow(/must differ from every generation course/);
    expect(
      localCiBackendConfigSchema.parse({ ...base, generation_course_ids: [9] })
        .evaluation_course_id,
    ).toBe(7);
  });

  test("supports deployment-specific endpoint templates", () => {
    const config = localCiBackendConfigSchema.parse(base);
    // Per participation, not the exercise-wide build-all: that one answers 200 but only loads
    // student participations, so on an evaluation exercise it builds nothing.
    expect(config.endpoints.trigger_build).toContain("participations/{participationId}");
    expect(config.endpoints.trigger_build).toContain("trigger-build");
    const overridden = localCiBackendConfigSchema.parse({
      ...base,
      endpoints: { trigger_build: "/custom/{participationId}/build" },
    });
    expect(overridden.endpoints.trigger_build).toBe("/custom/{participationId}/build");
    // Everything not overridden keeps its default, so a partial override is safe.
    expect(overridden.endpoints.commit_repository).toBe(config.endpoints.commit_repository);
  });

  test("reads participations and buildConfig from the plain exercise endpoint", () => {
    const config = localCiBackendConfigSchema.parse(base);
    // The `with-template-and-solution-participation` variant never carries `buildConfig` -- the
    // association is lazy and not fetched there -- so reading it there would silently produce a
    // fully unattested build.
    expect(config.endpoints.exercise_with_participations).toBe(
      "/api/programming/programming-exercises/{exerciseId}",
    );
    expect(config.endpoints.exercise_results).toContain("with-template-and-solution-participation");
    expect(config.endpoints.exercise_results).toContain("withSubmissionResults=true");
  });

  test("creates exercises with seeded repositories, because the empty path needs Hyperion", () => {
    const config = localCiBackendConfigSchema.parse(base);
    expect(config.endpoints.create_exercise).toContain("emptyRepositories=false");
  });
});

describe("LocalCI result mapping", () => {
  test("maps feedbacks onto test cases and non-test feedback onto diagnostics", () => {
    const build = toSubmissionBuild({
      result: { id: 1, completionDate: "2026-08-06T00:00:00Z" },
      submission: { id: 10, buildFailed: false },
      feedbacks: [
        { testCase: { testName: "sumsEvenValues" }, positive: true },
        {
          testCase: { testName: "handlesNegatives" },
          positive: false,
          detailText: "expected -6",
        },
        { text: "Compilation warning: unused import" },
      ],
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
      result: { id: 2, completionDate: "2026-08-06T00:00:00Z" },
      submission: { id: 11, buildFailed: true },
      feedbacks: [],
    });
    expect(build.compiled).toBe(false);
    expect(build.tests_executed).toBe(false);
    expect(passRate(build).rate).toBeNull();
  });

  test("a compiled build with no test cases is not treated as an executed suite", () => {
    const build = toSubmissionBuild({
      result: { id: 3, completionDate: "2026-08-06T00:00:00Z" },
      submission: { id: 12, buildFailed: false },
      feedbacks: [],
    });
    expect(build.compiled).toBe(true);
    expect(build.tests_executed).toBe(false);
  });

  test("reports no coverage, because Artemis exposes none", () => {
    // Artemis removed test-wise coverage (#9993) and `Result` carries no aggregate coverage field,
    // so the LocalCI backend must report `null` rather than infer a number from anything adjacent.
    const build = toSubmissionBuild({
      result: { id: 4, completionDate: "2026-08-06T00:00:00Z" },
      submission: { id: 13, buildFailed: false },
      feedbacks: [{ testCase: { testName: "t" }, positive: true }],
    });
    expect(build.coverage).toBeNull();
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
    solution: [
      {
        path: "src/A.java",
        content: "class A { int f() { return 1; } }",
        bytes: 33,
      },
    ],
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

  const CREDENTIALS = { username: "evaluation-account", password: "super-secret-password" };

  /**
   * A recorded deployment. Authentication is answered for every script, because the backend now
   * establishes a session before it does anything else; a script that omitted it would be testing a
   * flow no deployment permits.
   */
  function recordedFetch(script: Array<{ match: RegExp; status?: number; body: unknown }>): {
    fetchImplementation: LocalCiFetch;
    calls: Array<{ method: string; url: string; body: string | undefined }>;
  } {
    const calls: Array<{
      method: string;
      url: string;
      body: string | undefined;
    }> = [];
    const fetchImplementation: LocalCiFetch = async (url, init) => {
      calls.push({ method: init.method, url, body: init.body });
      if (url.includes("/authenticate")) {
        return {
          status: 200,
          text: async () => "",
          headers: { getSetCookie: () => ["jwt=recorded-session-token; Path=/; HttpOnly"] },
        };
      }
      const entry = script.find((candidate) => candidate.match.test(url));
      if (entry === undefined) {
        return { status: 404, text: async () => "" };
      }
      return {
        status: entry.status ?? 200,
        text: async () => JSON.stringify(entry.body),
      };
    };
    return { fetchImplementation, calls };
  }

  /** Answer authentication, then delegate: the session must exist before any other call. */
  function authAware(handler: LocalCiFetch): LocalCiFetch {
    return async (url, init) => {
      if (url.includes("/authenticate")) {
        return {
          status: 200,
          text: async () => "",
          headers: { getSetCookie: () => ["jwt=recorded-session-token; Path=/; HttpOnly"] },
        };
      }
      return handler(url, init);
    };
  }

  /** The build configuration a real deployment reports, verbatim from a committed run's evidence. */
  const BUILD_PLAN =
    '{"phases":[{"name":"compile","script":"mvn -B clean compile","condition":"ALWAYS","forceRun":false},{"name":"test","script":"mvn -B test","condition":"ALWAYS","forceRun":false,"resultPaths":["**/target/surefire-reports/*.xml"]}],"dockerImage":"ls1tum/artemis-maven-template:java17-25"}';

  const exercise = {
    id: 42,
    shortName: `exgeneval${"f".repeat(10)}`,
    projectKey: "EXGENEVAL0FFFFFFFFF",
    testRepositoryUri: "https://artemis.test/git/EXGENEVAL0FFFFFFFFF/exgeneval-tests.git",
    buildConfig: { branch: "main", buildPlanConfiguration: BUILD_PLAN, timeoutSeconds: 0 },
    templateParticipation: { id: 100 },
    solutionParticipation: { id: 200 },
  };

  const COMPLETED = "2026-08-06T00:00:00Z";

  /**
   * The seeded repositories Artemis leaves behind when an exercise is created with
   * `emptyRepositories=false`, and the results of the builds it runs over them. Both exist before
   * the candidate's bundle is written, which is exactly what the backend has to see past.
   */
  const SEEDED_FILES = {
    "pom.xml": "FILE",
    src: "FOLDER",
    "src/de/tum/cit/aet/exgen/BubbleSort.java": "FILE",
  };

  const SEED_RESULTS = { template: 1, solution: 2 };
  const NEW_RESULTS = { template: 8, solution: 9 };

  /**
   * A recorded Artemis, modelled on the conversation observed against the live deployment.
   *
   * It is stateful on purpose. Results only appear after the builds are triggered, so a backend that
   * read "the newest result" instead of "a result that did not exist before the bundle was
   * committed" would read a seed build here and the test would catch it.
   */
  function deployment(
    options: {
      exercise?: unknown;
      /** Polls of the results endpoint to answer with seed results only before the new ones land. */
      latency?: number;
      feedbacks?: Record<number, unknown[]>;
      /** Whether the builds report as failed, and what their build log says about why. */
      buildFailed?: boolean;
      buildLog?: Array<{ log: string }>;
    } = {},
  ): {
    fetchImplementation: LocalCiFetch;
    calls: Array<{ method: string; url: string; body: string | undefined }>;
  } {
    const body = options.exercise ?? exercise;
    const feedbacks = options.feedbacks ?? {
      [NEW_RESULTS.template]: [{ testCase: { testName: "t" }, positive: false }],
      [NEW_RESULTS.solution]: [{ testCase: { testName: "t" }, positive: true }],
      [SEED_RESULTS.template]: [],
      [SEED_RESULTS.solution]: [],
    };
    const calls: Array<{ method: string; url: string; body: string | undefined }> = [];
    let triggered = 0;
    let resultPolls = 0;

    const submissions = (participation: "template" | "solution", withNew: boolean) => [
      {
        id: SEED_RESULTS[participation] * 100,
        buildFailed: false,
        results: [{ id: SEED_RESULTS[participation], completionDate: COMPLETED }],
      },
      ...(withNew
        ? [
            {
              id: NEW_RESULTS[participation] * 100,
              buildFailed: options.buildFailed ?? false,
              results: [{ id: NEW_RESULTS[participation], completionDate: COMPLETED }],
            },
          ]
        : []),
    ];

    const fetchImplementation: LocalCiFetch = async (url, init) => {
      calls.push({ method: init.method, url, body: init.body });
      const json = (payload: unknown) => ({
        status: 200,
        text: async () => JSON.stringify(payload),
      });
      if (url.includes("/authenticate")) {
        return {
          status: 200,
          text: async () => "",
          headers: { getSetCookie: () => ["jwt=recorded-session-token; Path=/; HttpOnly"] },
        };
      }
      if (url.includes("/courses/7/programming-exercises")) return json([]);
      if (url.includes("/programming-exercises/setup")) return json(body);
      if (url.includes("with-template-and-solution-participation")) {
        resultPolls += 1;
        // Nothing new until the builds have been triggered and any configured latency has passed.
        const ready = triggered > 0 && resultPolls > (options.latency ?? 0);
        return json({
          id: 42,
          templateParticipation: { id: 100, submissions: submissions("template", ready) },
          solutionParticipation: { id: 200, submissions: submissions("solution", ready) },
        });
      }
      const details = url.match(/participations\/\d+\/results\/(\d+)\/details/);
      if (details) return json(feedbacks[Number(details[1])] ?? []);
      if (url.includes("/trigger-build")) {
        triggered += 1;
        return json({});
      }
      if (url.includes("/buildlogs")) return json(options.buildLog ?? []);
      if (/\/(test-)?repository\/\d+\/files$/.test(url)) return json(SEEDED_FILES);
      if (url.includes("/file?")) return json({});
      if (url.includes("/commit")) return json({});
      // The plain exercise read, and the delete, share a prefix; the delete carries a query string.
      if (url.includes("/programming-exercises/42")) return json(body);
      return { status: 404, text: async () => "" };
    };
    return { fetchImplementation, calls };
  }

  test("creates an exercise, pushes only candidate content, triggers and collects both builds", async () => {
    const { fetchImplementation, calls } = deployment();
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    const result = await backend.build(job() as never, new AbortController().signal);

    expect(oracleVerdict(result).satisfied).toBe(true);
    expect(result.attestation.backend_id).toBe("localci");

    // A session is established before anything else, and every later call carries it.
    expect(calls[0]?.url).toContain("/api/core/public/authenticate");
    expect(calls[0]?.method).toBe("POST");

    // The exercise is created unreleased, in the evaluation course, and removed afterwards.
    const setup = calls.find((call) => call.url.includes("setup"));
    expect(JSON.parse(setup?.body ?? "{}")).toMatchObject({
      // Artemis deserialises `Exercise` polymorphically; without the discriminator the request is
      // rejected before any validator runs.
      type: "programming",
      course: { id: 7 },
      releaseDate: null,
      // Artemis requires a participation mode, a project type and a package name, and dereferences
      // buildConfig unconditionally.
      allowOnlineEditor: true,
      projectType: "PLAIN_MAVEN",
    });
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/42?"))).toBe(true);

    // Only content the candidate itself produced crossed the boundary, and it went as the raw
    // request body rather than inside a JSON envelope that would be written into the repository.
    const pushed = calls
      .filter((call) => call.method === "POST" && call.url.includes("/file?"))
      .map((call) => call.body ?? "");
    expect(pushed).toEqual(["class A {}", "class A { int f() { return 1; } }", "class ATest {}"]);
    expect(pushed.join("\n")).not.toContain("golden");

    // Both participations are built individually; the exercise-wide build-all is never used.
    const triggers = calls.filter((call) => call.url.includes("/trigger-build"));
    expect(triggers.map((call) => call.url.match(/participations\/(\d+)\//)?.[1]).sort()).toEqual([
      "100",
      "200",
    ]);
    expect(calls.some((call) => call.url.includes("trigger-instructor-build-all"))).toBe(false);
  });

  test("makes each repository equal to the bundle, deleting whatever the seed left behind", async () => {
    const { fetchImplementation, calls } = deployment();
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    await backend.build(job() as never, new AbortController().signal);

    // Every seeded FILE is removed, in all three repositories, so the verdict is a function of the
    // bundle and not of Artemis's template. The FOLDER entry is not deleted: git has no folders, and
    // asking Artemis to remove one that its last file already took away is an error.
    const deletes = calls.filter((call) => call.method === "DELETE" && call.url.includes("/file?"));
    expect(deletes).toHaveLength(6);
    expect(deletes.some((call) => call.url.includes(encodeURIComponent("src")))).toBe(true);
    expect(
      deletes.every((call) => !call.url.includes(encodeURIComponent("src/de/tum/cit/aet/exgen"))),
    ).toBe(false);

    // Deleting precedes writing: Artemis refuses to create a path that already exists.
    const firstWrite = calls.findIndex(
      (call) => call.method === "POST" && call.url.includes("/file?"),
    );
    const lastDelete = calls.map((call) => call.method).lastIndexOf("DELETE");
    expect(calls[lastDelete]?.url).toContain("/programming-exercises/42?");
    expect(firstWrite).toBeGreaterThan(
      calls.findIndex((call) => call.method === "DELETE" && call.url.includes("/file?")),
    );
  });

  test("pushes the tests to the exercise's test repository, never through a participation", async () => {
    const { fetchImplementation, calls } = deployment();
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    await backend.build(job() as never, new AbortController().signal);

    const writes = calls.filter((call) => call.method === "POST" && call.url.includes("/file?"));
    const testWrites = writes.filter((call) => call.url.includes("/test-repository/"));
    const participationWrites = writes.filter((call) => !call.url.includes("/test-repository/"));

    // The tests artifact goes to the exercise by id; the template and solution go to participations.
    expect(testWrites).toHaveLength(1);
    expect(testWrites[0]?.url).toContain("/test-repository/42/file");
    expect(participationWrites.map((call) => call.url.match(/repository\/(\d+)\//)?.[1])).toEqual([
      "100",
      "200",
    ]);

    // Paths are the repository's own: nesting the suite under a prefix would make Maven compile it
    // as assignment code rather than as the exercise's tests.
    expect(testWrites[0]?.url).toContain(encodeURIComponent("src/ATest.java"));
    expect(calls.some((call) => call.url.includes("/test-repository/42/commit"))).toBe(true);
  });

  test("attests the build agent image and phase scripts the deployment reported", async () => {
    const { fetchImplementation } = deployment();
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    const { attestation } = await backend.build(job() as never, new AbortController().signal);

    expect(attestation.build_agent_image).toBe("ls1tum/artemis-maven-template:java17-25");
    expect(attestation.build_branch).toBe("main");
    expect(attestation.build_phase_scripts).toEqual([
      { name: "compile", script: "mvn -B clean compile" },
      { name: "test", script: "mvn -B test" },
    ]);
    // A content digest of the reported script, not an upstream revision.
    expect(attestation.build_script_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Artemis reports no revision of itself, so that one field stays an admitted gap.
    expect(attestation.artemis_revision).toBeNull();
    expect(attestation.unattested).toEqual(["artemis_revision"]);
  });

  test("a deployment that reports no build configuration attests nothing rather than guessing", async () => {
    const { fetchImplementation } = deployment({
      exercise: { ...exercise, buildConfig: undefined },
    });
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    const { attestation } = await backend.build(job() as never, new AbortController().signal);

    expect(attestation.build_agent_image).toBeNull();
    expect(attestation.build_script_revision).toBeNull();
    expect(attestation.build_phase_scripts).toEqual([]);
    expect(attestation.unattested).toEqual([
      "artemis_revision",
      "build_agent_image",
      "build_script_revision",
      "build_phase_scripts",
      "build_branch",
    ]);
  });

  test("a build plan the deployment reports in an unexpected shape degrades to unattested", async () => {
    const { fetchImplementation } = deployment({
      exercise: {
        ...exercise,
        buildConfig: { branch: "main", buildPlanConfiguration: "not json" },
      },
    });
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    const { attestation } = await backend.build(job() as never, new AbortController().signal);

    // Never a wrong attestation: the image and phases are absent, and only the digest of the exact
    // string the deployment sent survives.
    expect(attestation.build_agent_image).toBeNull();
    expect(attestation.build_phase_scripts).toEqual([]);
    expect(attestation.build_script_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(attestation.unattested).toContain("build_agent_image");
  });

  test("polls until a result completes", async () => {
    const { fetchImplementation, calls } = deployment({ latency: 3 });
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    const result = await backend.build(job() as never, new AbortController().signal);
    const polls = calls.filter((call) =>
      call.url.includes("with-template-and-solution-participation"),
    );
    // One baseline read, three polls that see only the seed builds, then the poll that finds the new
    // results and the confirming poll that shows them unchanged.
    expect(polls.length).toBeGreaterThanOrEqual(5);
    expect(result.solution.test_cases).toHaveLength(1);
  });

  test("reads the build the bundle produced, not the seed build Artemis ran on creation", async () => {
    // Seed builds are already complete before the bundle is pushed, and here the seed feedbacks
    // would invert the verdict: the seeded template passes and the seeded solution fails. Only a
    // backend that discounts results present before the commit reaches the right answer.
    const { fetchImplementation } = deployment({
      feedbacks: {
        [SEED_RESULTS.template]: [{ testCase: { testName: "t" }, positive: true }],
        [SEED_RESULTS.solution]: [{ testCase: { testName: "t" }, positive: false }],
        [NEW_RESULTS.template]: [{ testCase: { testName: "t" }, positive: false }],
        [NEW_RESULTS.solution]: [{ testCase: { testName: "t" }, positive: true }],
      },
    });
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    const outcome = await backend.build(job() as never, new AbortController().signal);
    expect(outcome.template.test_cases).toEqual([{ name: "t", passed: false }]);
    expect(outcome.solution.test_cases).toEqual([{ name: "t", passed: true }]);
    expect(oracleVerdict(outcome).satisfied).toBe(true);
  });

  test("a build LocalCI stopped is infrastructure, not an exercise that does not compile", async () => {
    // A killed build and a build whose code is broken are the same object in the results API:
    // `buildFailed`, no feedbacks, no test cases. Only the build log distinguishes them, so without
    // reading it an exhausted queue would be reported as a quality verdict about the candidate.
    const { fetchImplementation } = deployment({
      buildFailed: true,
      buildLog: [
        { log: "⚙️ executing test\n" },
        { log: "Error while executing build job 1: null\njava.util.concurrent.TimeoutException\n" },
        {
          log: "Timed out after 240 seconds. This may be due to an infinite loop or inefficient code.\n",
        },
      ],
    });
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    await expect(backend.build(job() as never, new AbortController().signal)).rejects.toThrow(
      /stopped the build at its timeout/,
    );
  });

  test("a build that failed to compile stays a quality verdict", async () => {
    // The other side of the same check: a failed build whose log carries no infrastructure
    // signature must remain a fact about the candidate, or every compile error becomes an outage.
    const { fetchImplementation } = deployment({
      buildFailed: true,
      buildLog: [{ log: "[ERROR] COMPILATION ERROR :\n" }, { log: "cannot find symbol\n" }],
    });
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    const outcome = await backend.build(job() as never, new AbortController().signal);
    expect(outcome.solution.compiled).toBe(false);
    expect(oracleVerdict(outcome).reasons).toContain("the solution does not compile");
  });

  test("a build that never completes is an infrastructure timeout, not a failing exercise", async () => {
    let clock = 0;
    // `latency: Infinity` means the triggered builds never produce a result, so only the seed
    // results are ever visible -- which the backend must refuse to read as this build's answer.
    const { fetchImplementation } = deployment({ latency: Number.POSITIVE_INFINITY });
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
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
    // Authentication succeeds, so the 503 lands on the build path rather than on the session.
    const fetchImplementation: LocalCiFetch = authAware(async () => ({
      status: 503,
      text: async () => "unavailable",
    }));
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
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
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    await backend.recover(job() as never, new AbortController().signal);
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/42?"))).toBe(true);
  });

  test("the credential never appears in a URL, and only the session travels afterwards", async () => {
    const { fetchImplementation, calls } = deployment();
    const backend = new LocalCiBuildBackend({
      config,
      credentials: CREDENTIALS,
      fetchImplementation,
      sleep: async () => undefined,
    });
    await backend.build(job() as never, new AbortController().signal).catch(() => undefined);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain(CREDENTIALS.password);
      expect(call.url).not.toContain(CREDENTIALS.username);
    }
    // The password appears in exactly one request body -- the authentication grant -- and nowhere else.
    const carrying = calls.filter((call) => (call.body ?? "").includes(CREDENTIALS.password));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.url).toContain("/authenticate");
  });

  test("a rejected credential is infrastructure, and a missing session cookie is refused", async () => {
    const refuse: LocalCiFetch = async () => ({ status: 401, text: async () => "" });
    await expect(
      new LocalCiBuildBackend({
        config,
        credentials: CREDENTIALS,
        fetchImplementation: refuse,
        sleep: async () => undefined,
      }).build(job() as never, new AbortController().signal),
    ).rejects.toThrow(/authentication returned HTTP 401/);

    // A 200 that sets no jwt cookie is not a session: continuing would send unauthenticated writes.
    const silent: LocalCiFetch = async () => ({ status: 200, text: async () => "" });
    await expect(
      new LocalCiBuildBackend({
        config,
        credentials: CREDENTIALS,
        fetchImplementation: silent,
        sleep: async () => undefined,
      }).build(job() as never, new AbortController().signal),
    ).rejects.toThrow(/did not return its jwt cookie/);
  });

  test("reads the jwt cookie out of Set-Cookie and ignores every other cookie", () => {
    expect(sessionCookie(["jwt=abc; Path=/; HttpOnly"])).toBe("abc");
    expect(sessionCookie(["XSRF-TOKEN=nope", "  jwt=second; Secure"])).toBe("second");
    expect(sessionCookie(["session=other"])).toBeUndefined();
    expect(sessionCookie([])).toBeUndefined();
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
    // Only the environment variable *names* are configured, never the credential itself.
    expect(config.username_env).toMatch(/^[A-Z_]+$/);
    expect(config.password_env).toMatch(/^[A-Z_]+$/);
    expect(config.username_env).not.toBe(config.password_env);
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
      workerConfigDigest({
        ...config,
        backend: { ...config.backend, offline: true },
      }),
    ).not.toBe(digest);
    expect(() => configDigestFromArgv([])).toThrow("requires --config-digest");
  });

  test("worker rejects a mismatched backend configuration digest before serving", async () => {
    const worker = resolve(import.meta.dir, "../evaluators/java-oracle/worker.ts");
    const config = resolve(import.meta.dir, "../evaluators/java-oracle/config.fixture.yaml");
    const child = Bun.spawn(
      [process.execPath, "run", worker, "--config", config, "--config-digest", "0".repeat(64)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("backend configuration digest mismatch");
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
    expect(() => createBackend(config, directory, {})).toThrow(/measures nothing/);
    expect(() => createBackend(config, directory, {}, {})).toThrow(/measures nothing/);
    expect(() => createBackend(config, directory, {}, { allowFixtureBackend: false })).toThrow(
      /measures nothing/,
    );
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
        request: {
          candidate: { case_id: "correct-exercise" },
        } as EvaluationRequest,
        bundle: {} as never,
      },
      new AbortController().signal,
    );
    expect(result.solution.test_cases).toHaveLength(3);
  });

  test("the LocalCI backend refuses to start without both halves of its credential", async () => {
    const { config, directory } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.localci.example.yaml"),
    );
    const username = config.username_env;
    const password = config.password_env;

    // The message names the variables that are missing, so an operator can act on it.
    expect(() => createBackend(config, directory, {})).toThrow(
      new RegExp(`requires a credential in ${username} and ${password}`),
    );
    expect(() => createBackend(config, directory, { [username]: "account" })).toThrow(
      new RegExp(`requires a credential in ${password}`),
    );
    expect(() => createBackend(config, directory, { [password]: "secret" })).toThrow(
      new RegExp(`requires a credential in ${username}`),
    );
    // An empty value is a missing value, not an anonymous session.
    expect(() =>
      createBackend(config, directory, { [username]: "account", [password]: "" }),
    ).toThrow(/requires a credential in/);

    const backend = createBackend(config, directory, {
      [username]: "account",
      [password]: "secret",
    });
    expect(backend.id).toBe("localci");
  });

  test("no credential can reach the configuration digest through the checked-in template", async () => {
    const { config } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.localci.example.yaml"),
    );
    // The template carries variable names and endpoints only; a value here would be committed.
    expect(JSON.stringify(config)).not.toMatch(/password["']?\s*:\s*["'][^"']+["']/i);
  });
});
