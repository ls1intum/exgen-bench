import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { loadReferenceSet } from "../src/data/reference-set.ts";
import { loadProcessEvaluatorConfig } from "../src/evaluation/process-config.ts";
import { discoverTools } from "../src/evaluation/tools.ts";
import { type MetricCard, readMetricCards } from "../src/export/metric-card.ts";
import { implementationDigest, implementationFiles, suiteDigest } from "../tools/kit/identity.ts";
import { CONSISTENCY_METRICS } from "../tools/tier1-deterministic/consistency/evaluate.ts";
import { ORACLE_METRICS } from "../tools/tier1-deterministic/java-oracle/evaluate.ts";
import {
  configDigestFromArgv,
  loadWorkerConfig,
  workerConfigDigest,
} from "../tools/tier1-deterministic/java-oracle/worker.ts";
import { STATIC_METRICS } from "../tools/tier1-deterministic/java-static/evaluate.ts";
import { TRACEABILITY_METRICS } from "../tools/tier1-deterministic/promise-traceability/scores.ts";
import { REFERENCE_METRICS } from "../tools/tier1-reference/java-reference/evaluate.ts";
import { RUBRIC_METRICS } from "../tools/tier2-judge/llm-judge/rubric.ts";

const TOOLS = resolve(import.meta.dir, "../tools");
const DETERMINISTIC = join(TOOLS, "tier1-deterministic");
const REFERENCE = join(TOOLS, "tier1-reference");

async function allCards(): Promise<MetricCard[]> {
  const tools = await discoverTools();
  return readMetricCards([...new Set(tools.flatMap((tool) => tool.metricCards))]);
}

const suites = [
  { directory: join(DETERMINISTIC, "java-oracle"), id: "java-oracle", metrics: ORACLE_METRICS },
  { directory: join(DETERMINISTIC, "java-static"), id: "java-static", metrics: STATIC_METRICS },
  {
    directory: join(REFERENCE, "java-reference"),
    id: "java-reference",
    metrics: REFERENCE_METRICS,
  },
  {
    directory: join(DETERMINISTIC, "consistency"),
    id: "consistency",
    metrics: CONSISTENCY_METRICS,
  },
  {
    directory: join(DETERMINISTIC, "promise-traceability"),
    id: "promise-traceability",
    metrics: TRACEABILITY_METRICS,
  },
  { directory: join(TOOLS, "tier2-judge", "llm-judge"), id: "llm-judge", metrics: RUBRIC_METRICS },
] as const;

describe("evaluator process configurations", () => {
  for (const suite of suites) {
    test(`${suite.id} loads and pins its implementation and suite`, async () => {
      const root = suite.directory;
      const loaded = await loadProcessEvaluatorConfig(join(root, "evaluator.yaml"));
      expect(loaded.evaluator.id).toBe(suite.id);
      expect(loaded.evaluator.implementation_digest).toBe(await implementationDigest(root));
      expect(await implementationFiles(root)).toContain("tools/kit/protocol.ts");
      if (suite.id === "java-reference") {
        const references = await loadReferenceSet(
          join(TOOLS, "kit/fixtures/suite/reference-set.yaml"),
        );
        expect(loaded.config.suite).toEqual({
          id: references.manifest.package.id,
          version: references.manifest.package.version,
          digest: references.manifest.digest,
        });
      } else {
        expect(loaded.config.suite.digest).toBe(await suiteDigest(root));
      }
      expect(loaded.evaluator.configuration_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    test(`${suite.id} requests exactly the metrics it emits`, async () => {
      const loaded = await loadProcessEvaluatorConfig(join(suite.directory, "evaluator.yaml"));
      expect([...loaded.config.requested_metrics].sort()).toEqual([...suite.metrics].sort());
    });
  }

  test("no published evaluator configuration selects a backend that measures nothing", async () => {
    const root = join(DETERMINISTIC, "java-oracle");
    for (const profile of ["evaluator.yaml", "evaluator.gradle.yaml"]) {
      const loaded = await loadProcessEvaluatorConfig(join(root, profile));
      const configFlag = loaded.config.process.argv.indexOf("--config");
      const configPath = loaded.config.process.argv[configFlag + 1];
      if (configPath === undefined) throw new Error(`${profile} has no backend configuration`);
      const { config: backend } = await loadWorkerConfig(join(root, configPath));
      expect(backend.backend.kind).not.toBe("fixture");
      expect(loaded.config.process.argv).not.toContain("--allow-fixture-backend");
    }
  });

  test("the java-oracle fixture profile is named apart and carries its own opt-in", async () => {
    const root = join(DETERMINISTIC, "java-oracle");
    const fixture = await loadProcessEvaluatorConfig(join(root, "evaluator.fixture.yaml"));
    expect(fixture.config.process.argv.join(" ")).toContain("config.fixture.yaml");
    expect(fixture.config.process.argv).toContain("--allow-fixture-backend");
  });

  test("the Java oracle publishes a Gradle target profile", async () => {
    const root = join(DETERMINISTIC, "java-oracle");
    const gradle = await loadProcessEvaluatorConfig(join(root, "evaluator.gradle.yaml"));
    expect(gradle.evaluator.target_profile).toBe("artemis-java-gradle");
    expect(gradle.config.process.argv).toContain("config.gradle.yaml");
    expect(gradle.evaluator.implementation_digest).toBe(await implementationDigest(root));
    expect(gradle.config.suite.digest).toBe(await suiteDigest(root));
  });

  test("every published Java oracle profile pins its backend configuration content", async () => {
    const root = join(DETERMINISTIC, "java-oracle");
    for (const [profile, backendName] of [
      ["evaluator.yaml", "config.maven.yaml"],
      ["evaluator.gradle.yaml", "config.gradle.yaml"],
      ["evaluator.fixture.yaml", "config.fixture.yaml"],
    ] as const) {
      const evaluator = await loadProcessEvaluatorConfig(join(root, profile));
      const { config: backend } = await loadWorkerConfig(join(root, backendName));
      expect(configDigestFromArgv(evaluator.config.process.argv)).toBe(workerConfigDigest(backend));
    }
  });

  test("every evaluator declares a distinct identity and suite", async () => {
    const loaded = await Promise.all(
      suites.map((suite) => loadProcessEvaluatorConfig(join(suite.directory, "evaluator.yaml"))),
    );
    expect(new Set(loaded.map((entry) => entry.evaluator.id)).size).toBe(suites.length);
    expect(new Set(loaded.map((entry) => entry.config.suite.id)).size).toBe(suites.length);
    expect(new Set(loaded.map((entry) => entry.evaluator.configuration_digest)).size).toBe(
      suites.length,
    );
  });
});

describe("evaluator metric cards", () => {
  test("string metrics carry a finite allowed-value vocabulary", async () => {
    const cards = await allCards();
    const stringMetrics = cards.filter((metric) => metric.value_type === "string");
    expect(stringMetrics.length).toBeGreaterThan(0);
    for (const metric of stringMetrics) {
      expect(metric.allowed_values?.length ?? 0).toBeGreaterThan(1);
    }
  });

  test("no secondary or deferred metric claims to be confirmatory", async () => {
    const cards = await allCards();
    const confirmatory = cards.filter((metric) => metric.tier === "confirmatory");
    expect(confirmatory.map((metric) => metric.id).sort()).toEqual([
      "oracle.satisfied",
      "strict-acceptance",
    ]);
    for (const metric of cards) {
      if (metric.id.startsWith("coverage.") || metric.id.startsWith("mutation.")) {
        expect(metric.tier).not.toBe("confirmatory");
      }
    }
  });

  test("every deferred metric says what it is waiting for", async () => {
    const cards = await allCards();
    for (const id of [
      "mutation.score",
      "reference.golden_tests_on_generated_pass_rate",
      "reference.generated_tests_on_golden_pass_rate",
      "reference.statement_embedding_similarity",
    ]) {
      const card = cards.find((metric) => metric.id === id);
      expect(card?.limitations).toMatch(/isolated backend|no embedding model/);
      expect(card?.validation.status).toBe("planned");
    }
  });
});
