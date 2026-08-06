import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import {
  readCandidateBundle,
  BundleIncomplete,
} from "../evaluators/promise-traceability/bundle.ts";
import { implementationDigest, suiteDigest } from "../evaluators/promise-traceability/identity.ts";
import { chatCompletion, judgeClaims } from "../evaluators/promise-traceability/model.ts";
import {
  buildScores,
  DETERMINISTIC_METRICS,
  MODEL_ASSISTED_METRICS,
} from "../evaluators/promise-traceability/scores.ts";
import { parseStatement } from "../evaluators/promise-traceability/statement.ts";
import { parseTestSuite } from "../evaluators/promise-traceability/java-tests.ts";
import { trace, type TraceabilityReport } from "../evaluators/promise-traceability/traceability.ts";
import { evaluationResponseSchema } from "../src/evaluation/contracts.ts";
import { metricCardsSchema } from "../src/export/metric-card.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";

const evaluatorDirectory = resolve("evaluators/promise-traceability");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const NON_MUTATION_STATEMENT = `# Summariser

| Type | Signature |
|------|-----------|
| \`Summariser\` | \`public class Summariser { public static Report summarise(java.util.List<Event> events) }\` |

The \`summarise\` method must never return \`null\` and must never modify the supplied list.
`;

const UNCHECKED_SUITE = `package example;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class SummariserTest {
    @Test
    void mixedEvents() {
        List<Event> events = List.of(new Event("a", 3));
        Report report = Summariser.summarise(events);
        assertEquals(1, report.count(), "one event in events");
    }
}
`;

function report(statement: string, suite: string): TraceabilityReport {
  return trace(statement, [{ path: "test/SuiteTest.java", text: suite }]);
}

function claim(result: TraceabilityReport, kind: string) {
  return result.claims.find((entry) => entry.kind === kind);
}

async function writeBundle(statement: string, files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "promise-traceability-"));
  temporaryDirectories.push(directory);
  const bundle = join(directory, "output");
  await mkdir(join(bundle, "artifacts", "tests"), { recursive: true });
  await writeFile(
    join(bundle, "response.json"),
    JSON.stringify({
      protocol_version: "1",
      request_id: "fixture",
      status: "succeeded",
      artifacts: [
        { role: "problem_statement", path: "artifacts/problem-statement.md" },
        { role: "template", path: "artifacts/template" },
        { role: "solution", path: "artifacts/solution" },
        { role: "tests", path: "artifacts/tests" },
      ],
    }),
  );
  await mkdir(join(bundle, "artifacts", "template"), { recursive: true });
  await mkdir(join(bundle, "artifacts", "solution"), { recursive: true });
  await writeFile(join(bundle, "artifacts", "problem-statement.md"), statement);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(bundle, "artifacts", "tests", name), contents);
  }
  return bundle;
}

describe("statement promise extraction", () => {
  test("separates a never-null promise from a never-modify promise in one sentence", () => {
    const statement = parseStatement(NON_MUTATION_STATEMENT);
    expect(statement.claims.map((entry) => entry.kind).sort()).toEqual([
      "no_mutation",
      "non_null_result",
    ]);
  });

  test("does not read a nullable-return promise out of a never-return-null sentence", () => {
    const statement = parseStatement(NON_MUTATION_STATEMENT);
    expect(statement.claims.some((entry) => entry.kind === "nullable_result")).toBe(false);
  });

  test("treats a guaranteed non-null input as a given rather than a promise", () => {
    const statement = parseStatement("The list supplied to the aggregator is never null.\n");
    expect(statement.claims).toEqual([]);
  });

  test("ignores framing sentences that describe the scaffolding", () => {
    const statement = parseStatement(
      "The template already contains the immutable value classes.\n",
    );
    expect(statement.claims).toEqual([]);
  });

  test("does not read an empty-input promise out of a non-empty requirement", () => {
    const statement = parseStatement("Each key is a non-empty string identifying a task.\n");
    expect(statement.claims.some((entry) => entry.kind === "empty_input")).toBe(false);
  });

  test("reports a normative sentence it cannot classify instead of dropping it", () => {
    const statement = parseStatement("Trips with a non-positive duration must be ignored.\n");
    expect(statement.claims).toEqual([]);
    expect(statement.unclassifiedNormativeUnits).toEqual([
      "Trips with a non-positive duration must be ignored.",
    ]);
  });

  test("collects declared types, methods, and record components as API members", () => {
    const statement = parseStatement(
      "| Type | Signature |\n|---|---|\n| `Event` | `public record Event(String name, int weight)` |\n| `Summariser` | `public class Summariser { public static Report summarise(java.util.List<Event> events) }` |\n",
    );
    expect(statement.apiMembers).toContain("Event");
    expect(statement.apiMembers).toContain("summarise");
    expect(statement.apiMembers).toContain("weight");
  });

  test("does not mistake the Artemis diagram colour marker for an API member", () => {
    const statement = parseStatement(
      "```plantuml\nclass <color:testsColor(<testid>1</testid>)>+Parser</color> {\n    +parse(String): Summary\n}\n```\n",
    );
    expect(statement.apiMembers).not.toContain("testsColor");
    expect(statement.apiMembers).toContain("parse");
  });
});

describe("test suite parsing", () => {
  test("separates the Artemis structural lane from behavioural test methods", () => {
    const suite = parseTestSuite([
      {
        path: "test/ClassTest.java",
        text: "class ClassTest extends ClassTestProvider {\n  @TestFactory\n  DynamicContainer generateTestsForAllClasses() { return null; }\n}\n",
      },
      { path: "test/SuiteTest.java", text: UNCHECKED_SUITE },
    ]);
    expect(suite.behaviouralMethods.map((method) => method.name)).toEqual(["mixedEvents"]);
    expect(suite.structuralFiles).toEqual(["test/ClassTest.java"]);
  });

  test("does not count an assertion that appears only in a comment", () => {
    const suite = parseTestSuite([
      {
        path: "test/SuiteTest.java",
        text: "class SuiteTest {\n  @Test\n  void placeholder() {\n    // assertEquals(1, 1);\n  }\n}\n",
      },
    ]);
    expect(suite.behaviouralMethods[0]?.assertions).toBe(0);
  });

  test("recognises an exception checked through instanceof on a wrapped cause", () => {
    const suite = parseTestSuite([
      {
        path: "test/SuiteTest.java",
        text: "class SuiteTest {\n  @Test\n  void rejects() {\n    InvocationTargetException e = assertThrows(InvocationTargetException.class, () -> deposit.invoke(a, 0.0));\n    assertTrue(e.getCause() instanceof AccountOperationException);\n  }\n}\n",
      },
    ]);
    expect(suite.assertThrownTypes).toContain("AccountOperationException");
  });
});

describe("promise-to-test tracing", () => {
  test("names a never-null promise unwitnessed when nothing asserts on the result", () => {
    const traced = report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE);
    expect(claim(traced, "non_null_result")?.witnessed).toBe(false);
  });

  test("names a never-modify promise unwitnessed when nothing re-reads the argument", () => {
    const traced = report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE);
    expect(claim(traced, "no_mutation")?.witnessed).toBe(false);
  });

  test("does not accept an assertion message mentioning the argument as a witness", () => {
    const traced = report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE);
    expect(claim(traced, "no_mutation")?.witness).toContain("no assertion re-reads");
  });

  test("credits a never-null promise when the result of the member is asserted", () => {
    const traced = report(
      NON_MUTATION_STATEMENT,
      UNCHECKED_SUITE.replace(
        "assertEquals(1, report.count()",
        "assertNotNull(report);\n        assertEquals(1, report.count()",
      ),
    );
    expect(claim(traced, "non_null_result")?.witnessed).toBe(true);
  });

  test("does not credit a never-null promise from an assertNotNull on an unrelated value", () => {
    const traced = report(
      NON_MUTATION_STATEMENT,
      UNCHECKED_SUITE.replace(
        "assertEquals(1, report.count()",
        "assertNotNull(events.get(0));\n        assertEquals(1, report.count()",
      ),
    );
    expect(claim(traced, "non_null_result")?.witnessed).toBe(false);
  });

  test("credits a never-modify promise when the test re-reads the argument afterwards", () => {
    const traced = report(
      NON_MUTATION_STATEMENT,
      UNCHECKED_SUITE.replace(
        'assertEquals(1, report.count(), "one event in events");',
        'assertEquals(List.of(new Event("a", 3)), events);',
      ),
    );
    expect(claim(traced, "no_mutation")?.witnessed).toBe(true);
  });

  test("does not treat a platform factory call as a call to the member under test", () => {
    const statement = `${NON_MUTATION_STATEMENT}\n| of | \`public static Report of(java.util.List<Event> events)\` |\n`;
    const traced = trace(statement, [
      {
        path: "test/SuiteTest.java",
        text: 'class SuiteTest {\n  @Test\n  void builds() {\n    List<Event> events = List.of(new Event("a", 3));\n    assertEquals(1, events.size());\n  }\n}\n',
      },
    ]);
    expect(claim(traced, "no_mutation")?.witnessed).toBe(false);
  });

  test("matches a stated exception type to its assertThrows", () => {
    const traced = report(
      "The constructor must throw an `IllegalArgumentException` when the width is negative.\n",
      "class SuiteTest {\n  @Test\n  void rejectsNegative() {\n    assertThrows(IllegalArgumentException.class, () -> new Grid(-1));\n  }\n}\n",
    );
    expect(claim(traced, "exception")?.witnessed).toBe(true);
  });

  test("reports a stated exception unwitnessed when no assertion expects it", () => {
    const traced = report(
      "If either argument is null you must throw a `NullPointerException`.\n",
      UNCHECKED_SUITE,
    );
    expect(claim(traced, "exception")?.detail).toBe("NullPointerException");
    expect(claim(traced, "exception")?.witnessed).toBe(false);
  });

  test("accepts assertions on distinct element positions as an ordering witness", () => {
    const traced = report(
      "The returned list is sorted by the start value in ascending order.\n",
      "class SuiteTest {\n  @Test\n  void sorted() {\n    assertEquals(1, merged.get(0).getStart());\n    assertEquals(8, merged.get(1).getStart());\n  }\n}\n",
    );
    expect(claim(traced, "ordering")?.witnessed).toBe(true);
  });

  test("finds an API member referenced only through a reflection string literal", () => {
    const traced = trace(
      "| Type | Signature |\n|---|---|\n| `Rectangle` | `public class Rectangle { public double getWidth() }` |\n",
      [
        {
          path: "test/SuiteTest.java",
          text: 'class SuiteTest {\n  @Test\n  void width() {\n    Object r = newInstance(getClazz("example.Rectangle"));\n    assertEquals(2.0, invokeMethod(r, getMethod(r, "getWidth")));\n  }\n}\n',
        },
      ],
    );
    expect(traced.members.filter((member) => !member.referenced)).toEqual([]);
  });

  test("counts a test method with no assertion at all", () => {
    const traced = report(
      NON_MUTATION_STATEMENT,
      "class SuiteTest {\n  @Test\n  void callsWithoutChecking() {\n    Summariser.summarise(List.of());\n  }\n}\n",
    );
    expect(traced.assertionlessMethods).toEqual(["test/SuiteTest.java#callsWithoutChecking"]);
  });
});

describe("score construction", () => {
  test("reports the claim ratio with the classified claims as its denominator", () => {
    const scores = buildScores(
      ["promise.witnessed_ratio"],
      report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE),
      undefined,
    );
    expect(scores[0]).toMatchObject({ status: "ok", numerator: 0, denominator: 2, value: 0 });
  });

  test("leaves the claim ratio not applicable when no claim could be classified", () => {
    const scores = buildScores(
      ["promise.witnessed_ratio"],
      report("Trips with a non-positive duration must be ignored.\n", UNCHECKED_SUITE),
      undefined,
    );
    expect(scores[0]?.status).toBe("not_applicable");
  });

  test("names each unwitnessed promise in the evidence of its count metric", () => {
    const scores = buildScores(
      ["promise.unwitnessed_claims"],
      report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE),
      undefined,
    );
    expect(scores[0]?.value).toBe(2);
    expect(scores[0]?.evidence.every((line) => line.startsWith("UNWITNESSED"))).toBe(true);
  });

  test("answers every deterministic metric it declares with a usable status", () => {
    const scores = buildScores(
      [...DETERMINISTIC_METRICS],
      report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE),
      undefined,
    );
    expect(scores.map((score) => score.metric_id)).toEqual([...DETERMINISTIC_METRICS]);
    expect(
      scores.every((score) => score.status === "ok" || score.status === "not_applicable"),
    ).toBe(true);
    expect(scores.find((score) => score.metric_id === "tests.structural_lane_present")?.value).toBe(
      false,
    );
    expect(scores.find((score) => score.metric_id === "tests.assertion_density")?.value).toBe(1);
  });

  test("leaves assertion density not applicable when the suite has no behavioural method", () => {
    const scores = buildScores(
      ["tests.assertion_density", "boundary.literal_ratio", "exception.assertthrows_ratio"],
      report("The result must never be `null`.\n", "class SuiteTest { }\n"),
      undefined,
    );
    expect(scores.map((score) => score.status)).toEqual([
      "not_applicable",
      "not_applicable",
      "not_applicable",
    ]);
  });

  test("refuses a metric it does not produce instead of inventing a value", () => {
    const scores = buildScores(
      ["mutation.score"],
      report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE),
      undefined,
    );
    expect(scores[0]).toMatchObject({ status: "not_applicable" });
    expect(scores[0]?.message).toContain("not produced");
  });

  test("reports the model layer's own claims separately from the deterministic ones", () => {
    const scores = buildScores(
      [...MODEL_ASSISTED_METRICS],
      report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE),
      {
        status: "ok",
        claims: [
          { claim: "never returns null", witnessed: false, rationale: "no assertNotNull" },
          { claim: "counts overdue events", witnessed: true, rationale: "asserted" },
        ],
      },
    );
    expect(scores.map((score) => score.value)).toEqual([2, 1, 0.5]);
  });

  test("marks every model-assisted metric not applicable while the layer is disabled", () => {
    const scores = buildScores(
      [...MODEL_ASSISTED_METRICS],
      report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE),
      undefined,
    );
    expect(scores.map((score) => score.status)).toEqual([
      "not_applicable",
      "not_applicable",
      "not_applicable",
    ]);
  });

  test("keeps a model-layer failure off the deterministic scores", () => {
    const scores = buildScores(
      ["promise.witnessed_ratio", "promise.model_claims"],
      report(NON_MUTATION_STATEMENT, UNCHECKED_SUITE),
      { status: "failed", message: "provider responded 503" },
    );
    expect(scores[0]?.status).toBe("ok");
    expect(scores[1]).toMatchObject({ status: "infra_failure", message: "provider responded 503" });
  });
});

describe("model-assisted layer", () => {
  test("reads claims and verdicts out of a fenced JSON completion", async () => {
    const outcome = await judgeClaims(
      async () =>
        '```json\n{"claims":[{"claim":"never returns null","witnessed":false,"rationale":"no assertNotNull"}]}\n```',
      NON_MUTATION_STATEMENT,
      UNCHECKED_SUITE,
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

  test("sends a bearer-authorised completion request and returns the message content", async () => {
    let seen: { authorization: string | null; model: unknown } | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { model: string };
        seen = { authorization: request.headers.get("authorization"), model: body.model };
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
      expect(seen).toEqual({ authorization: "Bearer fixture-key", model: "fixture-model" });
    } finally {
      await server.stop(true);
    }
  });

  test("reports a provider error as a layer failure rather than an empty claim set", async () => {
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
        message: "model-assisted layer failed: provider responded 503",
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe("candidate bundle reading", () => {
  test("rejects a candidate whose tests artifact holds no Java source", async () => {
    const bundle = await writeBundle(NON_MUTATION_STATEMENT, { "readme.md": "no tests here" });
    expect(readCandidateBundle(bundle)).rejects.toBeInstanceOf(BundleIncomplete);
  });

  test("reads the statement and tests through the declared artifact roles", async () => {
    const bundle = await writeBundle(NON_MUTATION_STATEMENT, { "SuiteTest.java": UNCHECKED_SUITE });
    const candidate = await readCandidateBundle(bundle);
    expect(candidate.problemStatement).toBe(NON_MUTATION_STATEMENT);
    expect(candidate.testFiles.map((file) => file.path)).toEqual(["SuiteTest.java"]);
  });
});

describe("evaluator process", () => {
  const invoke = async (bundle: string) => {
    const request = {
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
        bundle_path: bundle,
      },
      evaluator: {
        id: "promise-traceability",
        version: "1",
        revision: "fixture",
        target_profile: "artemis-java-maven",
        implementation_digest: "e".repeat(64),
      },
      suite: { id: "promise-traceability-study", version: "1", digest: "f".repeat(64) },
      requested_metrics: [...DETERMINISTIC_METRICS].sort(),
    };
    const child = Bun.spawn([process.execPath, "run", join(evaluatorDirectory, "worker.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify(request)),
      stdout: "pipe",
      stderr: "pipe",
      cwd: evaluatorDirectory,
    });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return evaluationResponseSchema.parse(JSON.parse(stdout));
  };

  test("answers a readable candidate with a schema-valid measured response", async () => {
    const response = await invoke(
      await writeBundle(NON_MUTATION_STATEMENT, { "SuiteTest.java": UNCHECKED_SUITE }),
    );
    expect(response.status).toBe("succeeded");
    expect(response.scores.map((score) => score.metric_id).sort()).toEqual(
      [...DETERMINISTIC_METRICS].sort(),
    );
    expect(
      response.scores.find((score) => score.metric_id === "promise.unwitnessed_claims")?.value,
    ).toBe(2);
  });

  test("answers an unmeasurable candidate as an incomplete candidate, not a crash", async () => {
    const response = await invoke(
      await writeBundle(NON_MUTATION_STATEMENT, { "readme.md": "no tests here" }),
    );
    expect(response.status).toBe("quality_failed");
    expect(response.failure_category).toBe("candidate.incomplete");
  });
});

describe("published evaluator identity", () => {
  const configs = ["config.yaml", "config.model-assisted.yaml"];

  test.each(configs)("%s declares the current implementation and suite digests", async (name) => {
    const config = processEvaluatorConfigSchema.parse(
      parse(await Bun.file(join(evaluatorDirectory, name)).text()),
    );
    expect(config.evaluator.implementation_digest).toBe(await implementationDigest());
    expect(config.suite.digest).toBe(await suiteDigest());
  });

  test.each(configs)("%s requests only metrics the suite publishes a card for", async (name) => {
    const config = processEvaluatorConfigSchema.parse(
      parse(await Bun.file(join(evaluatorDirectory, name)).text()),
    );
    const cards = metricCardsSchema.parse(
      await Bun.file(join(evaluatorDirectory, "metric-cards.json")).json(),
    );
    const published = new Set(cards.metrics.map((metric) => metric.id));
    expect(config.requested_metrics.filter((metric) => !published.has(metric))).toEqual([]);
  });

  test("publishes a card for every metric the evaluator can produce", async () => {
    const cards = metricCardsSchema.parse(
      await Bun.file(join(evaluatorDirectory, "metric-cards.json")).json(),
    );
    expect(cards.metrics.map((metric) => metric.id).sort()).toEqual(
      [...DETERMINISTIC_METRICS, ...MODEL_ASSISTED_METRICS].sort(),
    );
  });

  test("declares every model-assisted metric as exploratory and unvalidated", async () => {
    const cards = metricCardsSchema.parse(
      await Bun.file(join(evaluatorDirectory, "metric-cards.json")).json(),
    );
    const modelCards = cards.metrics.filter((metric) =>
      (MODEL_ASSISTED_METRICS as readonly string[]).includes(metric.id),
    );
    expect(modelCards).toHaveLength(MODEL_ASSISTED_METRICS.length);
    expect(modelCards.every((metric) => metric.tier === "exploratory")).toBe(true);
    expect(cards.metrics.every((metric) => metric.validation.status === "planned")).toBe(true);
  });
});
