import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOracleEvaluator } from "../evaluators/java-oracle/evaluate.ts";
import { FixtureBuildBackend } from "../evaluators/java-oracle/fixture-backend.ts";
import {
  compareVerdicts,
  STATUS_ONLY_METRICS,
  VERDICT_METRICS,
} from "../evaluators/java-oracle/m2-contract.ts";
import {
  LocalCiBuildBackend,
  localCiBackendConfigSchema,
  type LocalCiFetch,
} from "../evaluators/java-oracle/localci-backend.ts";
import { runEvaluation } from "../evaluators/shared/protocol.ts";
import { sha256 } from "../src/core/canonical.ts";
import type { EvaluationRequest } from "../src/evaluation/contracts.ts";

/**
 * An offline rehearsal of M2.
 *
 * `scripts/verify-m2-oracle.ts` runs the fixture corpus through both build backends and diffs the
 * verdicts. Its execution needs a live deployment (plan input I1), but its *logic* must not wait for
 * one: if the comparison itself is wrong, M2 would pass or fail for reasons unrelated to the
 * deployment and nobody would know. So the same comparison runs here against a recorded deployment
 * driven by `localci-recordings/`.
 *
 * What this establishes: the LocalCI backend's whole flow -- authenticate, create, read back, push to
 * three repositories, trigger, poll, map, attest -- produces verdicts identical to the fixture
 * backend's, and `compareVerdicts` detects it when they do not.
 *
 * What it cannot establish: that Artemis answers on these paths, in these shapes. That is M2 proper
 * and it stays gated on I1.
 */

const FIXTURES = resolve(import.meta.dir, "../evaluators/fixtures");
const RECORDINGS = join(FIXTURES, "oracle-recordings");
const RAW = join(FIXTURES, "localci-recordings");

const TEMPLATE_PARTICIPATION = 100;
const SOLUTION_PARTICIPATION = 200;
const EXERCISE_ID = 42;

const BUILD_PLAN =
  '{"phases":[{"name":"compile","script":"mvn -B clean compile","condition":"ALWAYS","forceRun":false},{"name":"test","script":"mvn -B test","condition":"ALWAYS","forceRun":false,"resultPaths":["**/target/surefire-reports/*.xml"]}],"dockerImage":"ls1tum/artemis-maven-template:java17-25"}';

const config = localCiBackendConfigSchema.parse({
  kind: "localci",
  base_url: "https://artemis.recorded.test",
  evaluation_course_id: 7,
  generation_course_ids: [9014],
  poll_interval_ms: 250,
  build_timeout_ms: 60_000,
});

function exercise(shortName: string) {
  return {
    id: EXERCISE_ID,
    shortName,
    projectKey: "EXGENEVALRECORDED",
    testRepositoryUri: "https://artemis.recorded.test/git/EXGENEVALRECORDED/tests.git",
    buildConfig: { branch: "main", buildPlanConfiguration: BUILD_PLAN, timeoutSeconds: 0 },
    templateParticipation: { id: TEMPLATE_PARTICIPATION },
    solutionParticipation: { id: SOLUTION_PARTICIPATION },
  };
}

/**
 * A deployment that answers from the raw payload recordings. `results` is undefined for the case
 * whose build never completes, so the poll loop runs to its deadline exactly as it would live.
 */
function recordedDeployment(results: { template: unknown; solution: unknown } | undefined): {
  fetchImplementation: LocalCiFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const json = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });
  const fetchImplementation: LocalCiFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.includes("/authenticate")) {
      return {
        status: 200,
        text: async () => "",
        headers: { getSetCookie: () => ["jwt=rehearsal-session; Path=/; HttpOnly"] },
      };
    }
    if (
      url.includes("/programming-exercises") &&
      init.method === "GET" &&
      url.includes("/courses/")
    ) {
      return json([]);
    }
    if (url.includes("setup")) {
      const body = JSON.parse(init.body ?? "{}") as { shortName?: string };
      return json(exercise(body.shortName ?? "unknown"));
    }
    if (url.includes("with-template-and-solution-participation")) {
      return json(exercise("recorded"));
    }
    if (url.includes(`/participations/${TEMPLATE_PARTICIPATION}/results`)) {
      return json(results === undefined ? [{ id: 1 }] : [results.template]);
    }
    if (url.includes(`/participations/${SOLUTION_PARTICIPATION}/results`)) {
      return json(results === undefined ? [{ id: 2 }] : [results.solution]);
    }
    return json({});
  };
  return { fetchImplementation, calls };
}

function request(caseId: string, backendId: string): EvaluationRequest {
  return {
    protocol_version: "1",
    evaluation_id: sha256(`m2-rehearsal:${backendId}:${caseId}`),
    candidate: {
      experiment_id: "m2-rehearsal",
      attempt_id: `${caseId}-attempt`,
      generation_key: sha256(`candidate:${caseId}`),
      case_id: caseId,
      system_id: "fixture-system",
      replicate: 1,
      artifact_digest: sha256(`artifact:${caseId}`),
      bundle_path: join(FIXTURES, caseId, "bundle"),
    },
    evaluator: {
      id: "java-oracle",
      version: "1",
      revision: `rehearsal-${backendId}`,
      target_profile: "artemis-java-maven",
      implementation_digest: sha256(`implementation:${backendId}`),
    },
    suite: { id: `java-oracle-${backendId}`, version: "1", digest: sha256(`suite:${backendId}`) },
    // The same set the M2 script demands. `requested_metrics` is a completeness check: an evaluator
    // that omits one is a protocol error, so asking for all ten here mirrors the live run exactly.
    requested_metrics: [...VERDICT_METRICS, ...STATUS_ONLY_METRICS],
  };
}

const CASES_WITH_BUILDS = [
  "correct-exercise",
  "template-already-passes",
  "solution-fails-tests",
  "solution-does-not-compile",
  "test-reads-forbidden-file",
  "statement-contradicts-tests",
  "reference-pair",
] as const;

async function rawResults(caseId: string): Promise<{ template: unknown; solution: unknown }> {
  return JSON.parse(await readFile(join(RAW, `${caseId}.json`), "utf8")) as {
    template: unknown;
    solution: unknown;
  };
}

async function evaluateBothBackends(
  caseId: string,
  results?: { template: unknown; solution: unknown },
) {
  const offline = await runEvaluation(
    request(caseId, "fixture"),
    createOracleEvaluator(new FixtureBuildBackend(RECORDINGS)),
  );
  const { fetchImplementation, calls } = recordedDeployment(results);
  let clock = 0;
  const live = await runEvaluation(
    request(caseId, "localci"),
    createOracleEvaluator(
      new LocalCiBuildBackend({
        config,
        credentials: { username: "evaluation-account", password: "rehearsal-password" },
        fetchImplementation,
        // The unfinished-build case must reach its deadline without spending 15 real minutes.
        sleep: async () => {
          clock += 30_000;
        },
        now: () => clock,
      }),
    ),
  );
  return { offline, live, calls };
}

describe("M2 rehearsal against a recorded deployment", () => {
  for (const caseId of CASES_WITH_BUILDS) {
    test(`${caseId} reaches the same verdict through both backends`, async () => {
      const { offline, live } = await evaluateBothBackends(caseId, await rawResults(caseId));
      expect(compareVerdicts(caseId, offline, live)).toEqual([]);
      // Guard against both sides being vacuously infrastructure failures.
      expect(offline.status).not.toBe("infra_failed");
    });
  }

  test("a build that never completes is an infrastructure failure on both sides", async () => {
    // The fixture recording is a recorded timeout; the recorded deployment never completes a result.
    // Neither side may produce a quality verdict, and they must agree that they did not.
    const { offline, live } = await evaluateBothBackends("non-terminating-test");
    expect(offline.status).toBe("infra_failed");
    expect(live.status).toBe("infra_failed");
    expect(live.strict_success).toBeNull();
    expect(live.failure_category).toBe("evaluator.timeout");
    expect(compareVerdicts("non-terminating-test", offline, live)).toEqual([]);
  });

  test("the whole live flow is exercised, not just the parts that answer", async () => {
    const { calls } = await evaluateBothBackends(
      "correct-exercise",
      await rawResults("correct-exercise"),
    );
    const joined = calls.join("\n");
    expect(joined).toContain("POST https://artemis.recorded.test/api/core/public/authenticate");
    expect(joined).toContain("with-template-and-solution-participation");
    expect(joined).toContain(`/repository/${TEMPLATE_PARTICIPATION}/file`);
    expect(joined).toContain(`/repository/${SOLUTION_PARTICIPATION}/file`);
    expect(joined).toContain(`/test-repository/${EXERCISE_ID}/file`);
    expect(joined).toContain("trigger-instructor-build-all");
    expect(joined).toContain(
      `DELETE https://artemis.recorded.test/api/programming/programming-exercises/${EXERCISE_ID}?`,
    );
    // Authentication happens once per backend instance, not once per request.
    expect(calls.filter((call) => call.includes("/authenticate"))).toHaveLength(1);
  });

  test("the comparison detects a divergence rather than reporting agreement", async () => {
    // Feed the live side the wrong case's results: the verdict must differ and be reported.
    const { offline } = await evaluateBothBackends(
      "correct-exercise",
      await rawResults("correct-exercise"),
    );
    const { live } = await evaluateBothBackends(
      "correct-exercise",
      await rawResults("template-already-passes"),
    );
    const divergences = compareVerdicts("correct-exercise", offline, live);
    expect(divergences.length).toBeGreaterThan(0);
    const detail = divergences.map((entry) => entry.detail).join("; ");
    expect(detail).toContain("oracle.satisfied");
    expect(detail).toContain("strict_success");
  });

  test("the live backend attests the recorded deployment's build configuration", async () => {
    const { fetchImplementation } = recordedDeployment(await rawResults("correct-exercise"));
    const backend = new LocalCiBuildBackend({
      config,
      credentials: { username: "evaluation-account", password: "rehearsal-password" },
      fetchImplementation,
      sleep: async () => undefined,
    });
    const outcome = await backend.build(
      {
        request: request("correct-exercise", "localci"),
        bundle: {
          root: "/bundle",
          statement: "# Even Sum",
          statementPath: "artifacts/problem-statement.md",
          template: [],
          solution: [],
          tests: [],
        },
      },
      new AbortController().signal,
    );
    expect(outcome.attestation.build_agent_image).toBe("ls1tum/artemis-maven-template:java17-25");
    expect(outcome.attestation.build_phase_scripts.map((phase) => phase.script)).toEqual([
      "mvn -B clean compile",
      "mvn -B test",
    ]);
    // The fixture backend attests nothing, which is the honest difference between the two.
    expect(outcome.attestation.unattested).toEqual(["artemis_revision"]);
  });
});
