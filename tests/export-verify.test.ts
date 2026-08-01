import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationObservation } from "../src/evaluation/summary.ts";
import { exportRelease } from "../src/export/release.ts";
import { verifyRelease } from "../src/export/verify.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release verification", () => {
  test("accepts an intact release and rejects changed derived data", async () => {
    const parent = await mkdtemp(join(tmpdir(), "exgen-verify-release-"));
    temporaryDirectories.push(parent);
    const outputDirectory = join(parent, "release");
    const generations: GenerationObservation[] = [
      {
        attempt_id: "attempt-1",
        case_id: "case-1",
        system_id: "system-1",
        replicate: 1,
        seed: 1,
        state: "failed",
        outcome: null,
        error_code: "fixture",
        started_at: "2026-07-30T00:00:00.000Z",
        finished_at: "2026-07-30T00:00:01.000Z",
        generation_key: "d".repeat(64),
        artifact_digest: null,
        evidence_digest: "e".repeat(64),
        budget_status: "compliant",
        budget_violations: [],
        budget_missing: [],
        generation_duration_ms: 1000,
        model_calls: null,
        tool_calls: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cost_amount: null,
        cost_currency: null,
      },
    ];
    await exportRelease({
      outputDirectory,
      release: {
        id: "fixture",
        version: "1",
        title: "Fixture",
        description: "Fixture",
        license: "CC-BY-4.0",
        url: "https://example.test/releases/fixture/1/",
        creators: [
          {
            name: "Felix Timotheus Johannes Dietrich",
            orcid: "https://orcid.org/0009-0007-5826-2061",
          },
          {
            name: "Sandro Speth",
            orcid: "https://orcid.org/0000-0002-9790-3702",
          },
        ],
        createdAt: "2026-07-30T00:00:00.000Z",
        designation: {
          status: "exploratory",
        },
      },
      benchmark: {
        id: "fixture",
        planDigest: "a".repeat(64),
        datasetId: "fixture",
        datasetVersion: "1",
        datasetDigest: "b".repeat(64),
        target: { id: "generic", version: "1", revision: "target" },
      },
      systems: [
        {
          id: "system-1",
          name: "System 1",
          version: "1",
          revision: "a",
          factors: {
            approach: { value: "fixture", control: "declared" as const },
            model: { value: "none", control: "declared" as const },
          },
          attestation: { deployment_deviations: [] },
        },
      ],
      cases: [
        {
          id: "case-1",
          title: "Case 1",
          tags: [],
          brief: "Fixture",
          digest: "c".repeat(64),
        },
      ],
      metricCards: [
        {
          id: "strict-acceptance",
          version: "1",
          name: "Strict acceptance",
          tier: "confirmatory",
          construct: "End-to-end strict success",
          unit: "proportion",
          value_type: "proportion",
          valid_range: { minimum: 0, maximum: 1 },
          direction: "higher is better",
          population: "planned attempts",
          denominator: "planned attempts",
          status_mapping: "strict success=1; otherwise=0",
          implementation: "evaluation protocol v1",
          evidence: "evaluation responses",
          validation: {
            status: "completed",
            method: "contract tested",
            evidence: [{ uri: "https://example.test/validation/strict" }],
          },
          limitations: "target-specific validity",
        },
      ],
      runManifest: {
        schema_version: "1",
        run_id: "fixture-run",
        run_instance_id: "fixture-instance",
        provenance: {},
      },
      generations,
      evaluations: [],
      evaluationHistory: [],
    });

    expect(await verifyRelease(outputDirectory)).toMatchObject({
      releaseId: "fixture",
      version: "1",
    });
    const unexpectedPath = join(outputDirectory, "unexpected.txt");
    await writeFile(unexpectedPath, "not declared\n");
    await expect(verifyRelease(outputDirectory)).rejects.toThrow("inventory mismatch");
    await rm(unexpectedPath);

    const linkPath = join(outputDirectory, "unexpected-link");
    await symlink("release-manifest.json", linkPath);
    await expect(verifyRelease(outputDirectory)).rejects.toThrow("symbolic link");
    await rm(linkPath);

    await writeFile(join(outputDirectory, "data/attempts.csv"), "tampered\n");
    await expect(verifyRelease(outputDirectory)).rejects.toThrow("checksum mismatch");
  });
});
