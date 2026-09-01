import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeEvidenceManifest } from "../src/core/evidence.ts";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import { runPlan } from "../src/core/run.ts";
import type { EvaluationRequest } from "../src/evaluation/contracts.ts";
import {
  builtInBundleEvaluatorIdentity,
  builtInDevelopmentSuite,
  executeBundleIntegrityEvaluation,
  loadEvaluationJournal,
  loadEvaluationJournalForRelease,
  loadRunEvaluationSource,
} from "../src/evaluation/source.ts";
import { evaluationResponse } from "./fixtures/evaluation.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function completedRun(): Promise<{ runDirectory: string; attemptIds: string[] }> {
  const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-source-"));
  temporaryDirectories.push(parentDirectory);
  const runDirectory = join(parentDirectory, "run");
  const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
  loaded.config.trials.replicates = 1;
  const plan = await createPlan(loaded);
  await runPlan(loaded, plan, "source-fixture", runDirectory, { create: true });
  return { runDirectory, attemptIds: plan.attempts.map((attempt) => attempt.id) };
}

async function readManifest(runDirectory: string): Promise<Record<string, never>> {
  return JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")) as Record<
    string,
    never
  >;
}

async function writeManifest(runDirectory: string, manifest: unknown): Promise<void> {
  await writeFile(join(runDirectory, "manifest.json"), JSON.stringify(manifest));
}

function editLedger(runDirectory: string, sql: string, parameters: unknown[] = []): void {
  const database = new Database(join(runDirectory, "ledger.sqlite"));
  database.query(sql).run(...(parameters as never[]));
  database.close();
}

/** Re-seals an attempt directory so a tampering test reaches the guard it targets. */
async function reseal(runDirectory: string, attemptId: string): Promise<void> {
  const digest = await writeEvidenceManifest(join(runDirectory, "attempts", attemptId));
  editLedger(runDirectory, "UPDATE attempts SET evidence_digest = ? WHERE id = ?", [
    digest,
    attemptId,
  ]);
}

describe("stored run projection", () => {
  test("loads a manifest carrying fields the projection does not model", async () => {
    const { runDirectory } = await completedRun();
    const manifest = (await readManifest(runDirectory)) as unknown as {
      plan: {
        systems: Array<Record<string, unknown>>;
        analysis: Record<string, unknown>;
        target: Record<string, unknown>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    manifest.future_top_level = { unknown: true };
    manifest.plan.future_plan_field = ["anything"];
    manifest.plan.analysis.future_knob = 42;
    manifest.plan.target.future_target_field = "value";
    const system = manifest.plan.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.future_system_field = { nested: [1, 2, 3] };
    await writeManifest(runDirectory, manifest);

    const source = await loadRunEvaluationSource(runDirectory);

    expect(source.systems[0]?.id).toBe("deterministic-mock");
    expect(source.candidates).toHaveLength(1);
  });

  test("keeps the dataset's own extensions, which decide a run's maximum release maturity", async () => {
    const { runDirectory } = await completedRun();
    const manifest = (await readManifest(runDirectory)) as unknown as {
      plan: { dataset: Record<string, unknown> };
    };
    manifest.plan.dataset.extensions = { exercise_package_status: "wip" };
    await writeManifest(runDirectory, manifest);

    const source = await loadRunEvaluationSource(runDirectory);

    expect(source.dataset.extensions).toEqual({ exercise_package_status: "wip" });
  });

  test("normalises a legacy bare-scalar factor to an unverified declaration", async () => {
    const { runDirectory } = await completedRun();
    const manifest = (await readManifest(runDirectory)) as unknown as {
      plan: { systems: Array<Record<string, unknown>> };
    };
    const system = manifest.plan.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { approach: "fixture", model: "none" };
    await writeManifest(runDirectory, manifest);

    const source = await loadRunEvaluationSource(runDirectory);

    expect(source.systems[0]?.factors).toEqual({
      approach: { value: "fixture", control: "declared" },
      model: { value: "none", control: "declared" },
    });
  });

  test.each([
    ["a plan digest that is not a digest", (plan: Record<string, unknown>) => (plan.id = "nope")],
    [
      "a system with no identity",
      (plan: Record<string, unknown>) => {
        (plan.systems as Array<Record<string, unknown>>)[0] = { name: "System" };
      },
    ],
    [
      "a confidence level outside zero and one",
      (plan: Record<string, unknown>) => {
        (plan.analysis as Record<string, unknown>).confidence_level = 5;
      },
    ],
    [
      "an attestation whose deviations are not a list",
      (plan: Record<string, unknown>) => {
        const systems = plan.systems as Array<Record<string, unknown>>;
        const system = systems[0];
        if (system) {
          system.attestation = { deployment_deviations: "none" };
        }
      },
    ],
    [
      "a target with no revision",
      (plan: Record<string, unknown>) => {
        const target = plan.target as Record<string, unknown>;
        target.revision = undefined;
      },
    ],
  ])("rejects a manifest with %s rather than projecting it", async (_label, corrupt) => {
    const { runDirectory } = await completedRun();
    const manifest = (await readManifest(runDirectory)) as unknown as {
      plan: Record<string, unknown>;
    };
    corrupt(manifest.plan);
    await writeManifest(runDirectory, manifest);

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow();
  });
});

describe("run evidence verification", () => {
  test("rejects a terminal attempt with no evidence digest", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    editLedger(runDirectory, "UPDATE attempts SET evidence_digest = NULL");

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow(
      `terminal attempt ${attemptIds[0]} has no evidence digest`,
    );
  });

  test("rejects an attempt whose evidence was edited after it was sealed", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }
    await writeFile(join(runDirectory, "attempts", attemptId, "stdout.log"), "tampered\n");

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow("evidence digest mismatch");
  });

  test("rejects an attempt whose observation disagrees with its ledger row", async () => {
    const { runDirectory } = await completedRun();
    editLedger(runDirectory, "UPDATE attempts SET outcome = 'abstained'");

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow(
      "observation does not reconcile with ledger attempt",
    );
  });

  test("rejects a sealed attempt whose observation is missing", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }
    await rm(join(runDirectory, "attempts", attemptId, "observation.json"));
    await reseal(runDirectory, attemptId);

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow(
      `terminal attempt ${attemptId} has no observation`,
    );
  });

  test("rejects a sealed attempt whose observation is not a valid observation", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }
    await writeFile(
      join(runDirectory, "attempts", attemptId, "observation.json"),
      JSON.stringify({ schema_version: "1", lifecycle: "sideways" }),
    );
    await reseal(runDirectory, attemptId);

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow(
      `invalid generation observation for ${attemptId}`,
    );
  });

  test("rejects an attempt whose artifacts no longer hash to the recorded digest", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }
    const forged = "9".repeat(64);
    const observationPath = join(runDirectory, "attempts", attemptId, "observation.json");
    const observation = JSON.parse(await readFile(observationPath, "utf8")) as Record<
      string,
      unknown
    >;
    observation.artifact_digest = forged;
    await writeFile(observationPath, JSON.stringify(observation));
    await reseal(runDirectory, attemptId);
    editLedger(runDirectory, "UPDATE attempts SET artifact_digest = ? WHERE id = ?", [
      forged,
      attemptId,
    ]);

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow(
      `artifact digest mismatch for completed attempt ${attemptId}`,
    );
  });

  test("rejects an attempt that claims artifacts without a generation response", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }
    const observationPath = join(runDirectory, "attempts", attemptId, "observation.json");
    const observation = JSON.parse(await readFile(observationPath, "utf8")) as Record<
      string,
      unknown
    >;
    observation.response = undefined;
    await writeFile(observationPath, JSON.stringify(observation));
    await reseal(runDirectory, attemptId);

    await expect(loadRunEvaluationSource(runDirectory)).rejects.toThrow(
      `completed attempt ${attemptId} has no generation response`,
    );
  });
});

describe("built-in bundle integrity evaluator", () => {
  async function bundleRequest(
    runDirectory: string,
    attemptId: string,
    overrides: Partial<EvaluationRequest["candidate"]> = {},
  ): Promise<EvaluationRequest> {
    const source = await loadRunEvaluationSource(runDirectory);
    const candidate = source.candidates.find((entry) => entry.attempt_id === attemptId);
    if (!candidate) {
      throw new Error("run produced no candidate");
    }
    return {
      protocol_version: "1",
      evaluation_id: "a".repeat(64),
      candidate: { ...candidate, ...overrides },
      evaluator: await builtInBundleEvaluatorIdentity(source.target),
      suite: builtInDevelopmentSuite(source.target),
      requested_metrics: [],
    };
  }

  test("binds the evaluator and suite identity to the target", async () => {
    const { runDirectory } = await completedRun();
    const source = await loadRunEvaluationSource(runDirectory);

    const evaluator = await builtInBundleEvaluatorIdentity(source.target);
    const suite = builtInDevelopmentSuite(source.target);
    const other = await builtInBundleEvaluatorIdentity({ ...source.target, id: "other-target" });

    expect(evaluator.target_profile).toBe(source.target.id);
    expect(other.configuration_digest).not.toBe(evaluator.configuration_digest);
    expect(builtInDevelopmentSuite({ ...source.target, id: "other-target" }).digest).not.toBe(
      suite.digest,
    );
  });

  test("accepts a bundle whose artifacts still hash to the recorded digest", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }

    const response = await executeBundleIntegrityEvaluation(
      await bundleRequest(runDirectory, attemptId),
    );

    expect(response.status).toBe("succeeded");
    expect(response.strict_success).toBeTrue();
    expect(response.scores[0]?.value).toBeTrue();
    expect(response.candidate.capture_completeness).toBe("complete");
  });

  test("fails a bundle whose artifacts no longer hash to the recorded digest", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }
    const request = await bundleRequest(runDirectory, attemptId, {
      artifact_digest: "f".repeat(64),
    });

    const response = await executeBundleIntegrityEvaluation(request);

    expect(response.status).toBe("quality_failed");
    expect(response.strict_success).toBeFalse();
    expect(response.failure_category).toBe("candidate.invalid");
  });

  test("reports an unreadable bundle as a quality failure, not a crash", async () => {
    const { runDirectory, attemptIds } = await completedRun();
    const attemptId = attemptIds[0];
    if (!attemptId) {
      throw new Error("fixture has no attempt");
    }
    const request = await bundleRequest(runDirectory, attemptId, {
      bundle_path: join(runDirectory, "attempts", attemptId, "missing"),
    });

    const response = await executeBundleIntegrityEvaluation(request);

    expect(response.status).toBe("quality_failed");
    expect(response.failure_category).toBe("candidate.invalid");
    expect(response.scores[0]?.message).toBeString();
  });
});

describe("evaluation journal loading", () => {
  const record = (evaluationId: string, status: "succeeded" | "infra_failed") =>
    evaluationResponse({ evaluation_id: evaluationId, status });

  async function journalWith(records: unknown[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "exgen-journal-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "evaluations.jsonl");
    await writeFile(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return path;
  }

  test("returns the latest outcome per evaluation, sorted by identity", async () => {
    const path = await journalWith([
      record("b".repeat(64), "succeeded"),
      record("a".repeat(64), "succeeded"),
    ]);

    const latest = await loadEvaluationJournal(path);

    expect(latest.map((entry) => entry.evaluation_id)).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  test("keeps every retry in the history while reporting one sorted latest outcome", async () => {
    const path = await journalWith([
      record("b".repeat(64), "succeeded"),
      record("a".repeat(64), "infra_failed"),
      record("a".repeat(64), "succeeded"),
    ]);

    const { latest, history } = await loadEvaluationJournalForRelease(path);

    expect(history).toHaveLength(3);
    expect(latest.map((entry) => entry.evaluation_id)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(latest[0]?.status).toBe("succeeded");
  });
});
