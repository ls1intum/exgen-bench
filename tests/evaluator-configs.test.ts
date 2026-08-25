import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONSISTENCY_METRICS } from "../evaluators/consistency/evaluate.ts";
import { ORACLE_METRICS } from "../evaluators/java-oracle/evaluate.ts";
import {
  configDigestFromArgv,
  loadWorkerConfig,
  workerConfigDigest,
} from "../evaluators/java-oracle/worker.ts";
import { REFERENCE_METRICS } from "../evaluators/java-reference/evaluate.ts";
import { STATIC_METRICS } from "../evaluators/java-static/evaluate.ts";
import {
  implementationDigest,
  implementationFiles,
  suiteDigest,
} from "../evaluators/shared/identity.ts";
import { loadProcessEvaluatorConfig } from "../src/evaluation/process-config.ts";
import { loadReferenceSet } from "../src/data/reference-set.ts";
import { metricCardsSchema } from "../src/export/metric-card.ts";

const EVALUATORS = resolve(import.meta.dir, "../evaluators");

const suites = [
  { directory: "java-oracle", id: "java-oracle", metrics: ORACLE_METRICS },
  { directory: "java-static", id: "java-static", metrics: STATIC_METRICS },
  { directory: "java-reference", id: "java-reference", metrics: REFERENCE_METRICS },
  { directory: "consistency", id: "consistency", metrics: CONSISTENCY_METRICS },
] as const;

describe("evaluator process configurations", () => {
  for (const suite of suites) {
    test(`${suite.id} loads and pins its implementation and suite`, async () => {
      const root = join(EVALUATORS, suite.directory);
      const loaded = await loadProcessEvaluatorConfig(join(root, "evaluator.yaml"));
      expect(loaded.evaluator.id).toBe(suite.id);
      // The whole import closure, not the worker: a worker is an argv shim, and every evaluator's
      // measurement lives in the modules it reaches.
      expect(loaded.evaluator.implementation_digest).toBe(await implementationDigest(root));
      expect(await implementationFiles(root)).toContain("evaluators/shared/protocol.ts");
      if (suite.id === "java-reference") {
        const references = await loadReferenceSet(
          join(EVALUATORS, "fixtures/suite/reference-set.yaml"),
        );
        expect(loaded.config.suite).toEqual({
          id: references.manifest.package.id,
          version: references.manifest.package.version,
          digest: references.manifest.digest,
        });
      } else {
        expect(loaded.config.suite.digest).toBe(await suiteDigest(root));
      }
      // The digest exgen derives from the secret-free configuration must be stable and present.
      expect(loaded.evaluator.configuration_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    test(`${suite.id} requests exactly the metrics it emits`, async () => {
      const loaded = await loadProcessEvaluatorConfig(
        join(EVALUATORS, suite.directory, "evaluator.yaml"),
      );
      expect([...loaded.config.requested_metrics].sort()).toEqual([...suite.metrics].sort());
    });

    test(`${suite.id} passes no credential through argv`, async () => {
      const loaded = await loadProcessEvaluatorConfig(
        join(EVALUATORS, suite.directory, "evaluator.yaml"),
      );
      // argv is recorded verbatim in the configuration digest and the journal.
      expect(loaded.config.process.argv.join(" ")).not.toMatch(/token|secret|password|bearer/i);
    });
  }

  test("no published evaluator configuration selects a backend that measures nothing", async () => {
    for (const suite of suites) {
      const loaded = await loadProcessEvaluatorConfig(
        join(EVALUATORS, suite.directory, "evaluator.yaml"),
      );
      // A replay backend produces a journal that reads like a real one, so the default configuration
      // of every evaluator has to name something that actually builds or analyses the candidates.
      expect(loaded.config.process.argv.join(" ")).not.toContain("config.fixture.yaml");
      expect(loaded.config.process.argv).not.toContain("--allow-fixture-backend");
    }
  });

  test("the java-oracle fixture profile is named apart and carries its own opt-in", async () => {
    const root = join(EVALUATORS, "java-oracle");
    const fixture = await loadProcessEvaluatorConfig(join(root, "evaluator.fixture.yaml"));
    expect(fixture.config.process.argv.join(" ")).toContain("config.fixture.yaml");
    expect(fixture.config.process.argv).toContain("--allow-fixture-backend");
    // It measures nothing, so it must never be mistaken for the default in a journal: the argv it
    // pins differs, and argv is inside the configuration digest.
    const published = await loadProcessEvaluatorConfig(join(root, "evaluator.yaml"));
    expect(fixture.evaluator.configuration_digest).not.toBe(
      published.evaluator.configuration_digest,
    );
  });

  test("the Java oracle publishes a Gradle target profile", async () => {
    const root = join(EVALUATORS, "java-oracle");
    const gradle = await loadProcessEvaluatorConfig(join(root, "evaluator.gradle.yaml"));
    expect(gradle.evaluator.target_profile).toBe("artemis-java-gradle");
    expect(gradle.config.process.argv).toContain("config.gradle.yaml");
    const { config: backend } = await loadWorkerConfig(join(root, "config.gradle.yaml"));
    expect(configDigestFromArgv(gradle.config.process.argv)).toBe(workerConfigDigest(backend));
    expect(gradle.evaluator.implementation_digest).toBe(await implementationDigest(root));
    expect(gradle.config.suite.digest).toBe(await suiteDigest(root));
  });

  test("every published Java oracle profile pins its backend configuration content", async () => {
    const root = join(EVALUATORS, "java-oracle");
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
      suites.map((suite) =>
        loadProcessEvaluatorConfig(join(EVALUATORS, suite.directory, "evaluator.yaml")),
      ),
    );
    expect(new Set(loaded.map((entry) => entry.evaluator.id)).size).toBe(suites.length);
    expect(new Set(loaded.map((entry) => entry.config.suite.id)).size).toBe(suites.length);
    expect(new Set(loaded.map((entry) => entry.evaluator.configuration_digest)).size).toBe(
      suites.length,
    );
  });
});

describe("evaluator metric cards", () => {
  test("document every metric the Phase 1 evaluators can emit", async () => {
    const cards = metricCardsSchema.parse(
      JSON.parse(await readFile(join(EVALUATORS, "metric-cards.json"), "utf8")),
    );
    const documented = new Set(cards.metrics.map((metric) => metric.id));
    const emitted = [
      ...ORACLE_METRICS,
      ...STATIC_METRICS,
      ...REFERENCE_METRICS,
      ...CONSISTENCY_METRICS,
    ];
    expect([...new Set(emitted)].filter((metric) => !documented.has(metric))).toEqual([]);
    expect(documented.has("strict-acceptance")).toBe(true);
  });

  test("string metrics carry a finite allowed-value vocabulary", async () => {
    const cards = metricCardsSchema.parse(
      JSON.parse(await readFile(join(EVALUATORS, "metric-cards.json"), "utf8")),
    );
    const stringMetrics = cards.metrics.filter((metric) => metric.value_type === "string");
    expect(stringMetrics.length).toBeGreaterThan(0);
    for (const metric of stringMetrics) {
      expect(metric.allowed_values?.length ?? 0).toBeGreaterThan(1);
    }
  });

  test("no secondary or deferred metric claims to be confirmatory", async () => {
    const cards = metricCardsSchema.parse(
      JSON.parse(await readFile(join(EVALUATORS, "metric-cards.json"), "utf8")),
    );
    const confirmatory = cards.metrics.filter((metric) => metric.tier === "confirmatory");
    // Exactly one gate decides the primary estimand, plus the release-level acceptance metric.
    expect(confirmatory.map((metric) => metric.id).sort()).toEqual([
      "oracle.satisfied",
      "strict-acceptance",
    ]);
    for (const metric of cards.metrics) {
      if (metric.id.startsWith("coverage.") || metric.id.startsWith("mutation.")) {
        expect(metric.tier).not.toBe("confirmatory");
      }
    }
  });

  test("every deferred metric says what it is waiting for", async () => {
    const cards = metricCardsSchema.parse(
      JSON.parse(await readFile(join(EVALUATORS, "metric-cards.json"), "utf8")),
    );
    for (const id of [
      "mutation.score",
      "reference.golden_tests_on_generated_pass_rate",
      "reference.generated_tests_on_golden_pass_rate",
      "reference.statement_embedding_similarity",
    ]) {
      const card = cards.metrics.find((metric) => metric.id === id);
      expect(card?.limitations).toMatch(/WP2c|container backend|D6|deferred/);
      expect(card?.validation.status).toBe("planned");
    }
  });
});
