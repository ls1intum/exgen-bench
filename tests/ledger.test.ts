import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../src/core/ledger.ts";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable attempt ledger", () => {
  test("claims an attempt once and persists its terminal state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-ledger-"));
    temporaryDirectories.push(directory);
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const plan = await createPlan(loaded);
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("fixture plan has no attempt");
    }

    const ledger = await Ledger.create(directory, plan);
    expect(ledger.claim(attempt.id, "2026-07-30T00:00:00Z")).toBeTrue();
    expect(ledger.claim(attempt.id, "2026-07-30T00:00:01Z")).toBeFalse();
    ledger.finish(attempt.id, "completed", {
      occurredAt: "2026-07-30T00:00:02Z",
      outcome: "succeeded",
      artifactDigest: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
    });
    ledger.close();

    const reopened = Ledger.open(directory);
    const row = reopened.list().find((candidate) => candidate.id === attempt.id);
    expect(row?.state).toBe("completed");
    expect(row?.outcome).toBe("succeeded");
    expect(row?.artifactDigest).toBe("a".repeat(64));
    expect(row?.evidenceDigest).toBe("b".repeat(64));
    reopened.close();
  });
});
