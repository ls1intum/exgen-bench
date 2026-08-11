#!/usr/bin/env bun

/**
 * M2: does the live Artemis LocalCI backend reach the same verdicts as the reproducible offline
 * fixture backend, over the same bundles?
 *
 * This is the acceptance criterion for WP8 in the evaluation-completion plan (§4, WP2 acceptance:
 * "identical verdicts from the live backend on the same fixtures in M2"). It runs the fixture corpus
 * through both backends and diffs them. Divergence is the finding, so it exits non-zero and prints
 * the offending metric rather than summarising.
 *
 * It needs a live deployment and a dedicated evaluation-course credential (plan input I1). Without
 * them it explains what is missing and exits 2 — it never fabricates a pass.
 *
 * Usage:
 *   ARTEMIS_EVALUATION_USERNAME=... ARTEMIS_EVALUATION_PASSWORD=... \
 *     bun run scripts/verify-m2-oracle.ts <localci-config.yaml> [case-id ...]
 *
 * What it compares, and why not everything:
 *
 * - The **verdict** must match exactly: `status`, `strict_success`, `failure_category`, and every
 *   metric whose value is a property of the exercise rather than of the deployment.
 * - Coverage is compared by *status only*. `coverage.statement` is a real measurement of a real build,
 *   so its value legitimately differs from the hand-authored recording; requiring equality there would
 *   fail M2 for the wrong reason. `coverage.branch` must be `not_applicable` on both sides: the
 *   Artemis coverage endpoint reports line counts only (WP8 Tasks 1-2 finding), and it stays declared
 *   for the container backend (WP2c).
 * - `mutation.score` must be `not_applicable` on both sides. It needs sealed assets and is out of
 *   scope until WP2c.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOracleEvaluator } from "../evaluators/java-oracle/evaluate.ts";
import { FixtureBuildBackend } from "../evaluators/java-oracle/fixture-backend.ts";
import {
  compareVerdicts,
  STATUS_ONLY_METRICS,
  VERDICT_METRICS,
  type Divergence,
} from "../evaluators/java-oracle/m2-contract.ts";
import { createBackend, loadWorkerConfig } from "../evaluators/java-oracle/worker.ts";
import { runEvaluation } from "../evaluators/shared/protocol.ts";
import { sha256 } from "../src/core/canonical.ts";
import type { EvaluationRequest } from "../src/evaluation/contracts.ts";
import type { BuildBackend } from "../evaluators/java-oracle/backend.ts";

const FIXTURES = resolve(import.meta.dir, "../evaluators/fixtures");

function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "usage: bun run scripts/verify-m2-oracle.ts <localci-config.yaml> [case-id ...]\n\n" +
      "Requires a live Artemis deployment (plan input I1) and these environment variables,\n" +
      "whose names come from the config file's username_env / password_env:\n" +
      "  ARTEMIS_EVALUATION_USERNAME   evaluation-course account, not the generation account\n" +
      "  ARTEMIS_EVALUATION_PASSWORD   its password\n\n" +
      "The config file must set backend.kind: localci, base_url, evaluation_course_id, and\n" +
      "generation_course_ids (so the schema can refuse an evaluation course that a generation\n" +
      "run also writes to). Start from evaluators/java-oracle/config.localci.example.yaml.\n",
  );
  process.exit(2);
}

async function fixtureCases(): Promise<string[]> {
  const entries = await readdir(FIXTURES, { withFileTypes: true });
  const named = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        (await Bun.file(join(FIXTURES, entry.name, "expected.json")).exists()) ? entry.name : null,
      ),
  );
  return named.filter((name): name is string => name !== null).sort();
}

/**
 * One request per (case, backend). The evaluation id is derived from the case and the backend so the
 * two runs are distinguishable in a journal, and so the LocalCI backend's deterministic exercise
 * short name differs between them rather than colliding on a shared remote exercise.
 */
function request(caseId: string, backendId: string): EvaluationRequest {
  return {
    protocol_version: "1",
    evaluation_id: sha256(`m2:${backendId}:${caseId}`),
    candidate: {
      experiment_id: "m2-verification",
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
      revision: `m2-${backendId}`,
      target_profile: "artemis-java-maven",
      implementation_digest: sha256(`implementation:${backendId}`),
    },
    suite: {
      id: `java-oracle-m2-${backendId}`,
      version: "1",
      digest: sha256(`suite:${backendId}`),
    },
    requested_metrics: [...VERDICT_METRICS, ...STATUS_ONLY_METRICS],
  };
}

const [configPath, ...requestedCases] = process.argv.slice(2);
if (configPath === undefined) {
  usage("a LocalCI backend configuration is required");
}

const loaded = await loadWorkerConfig(resolve(configPath));
if (loaded.config.backend.kind !== "localci") {
  usage(`${configPath} declares backend.kind: ${loaded.config.backend.kind}, but M2 needs localci`);
}

let live: BuildBackend;
try {
  live = createBackend(loaded.config, loaded.directory, process.env);
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

const offline = new FixtureBuildBackend(join(FIXTURES, "oracle-recordings"));
const cases = requestedCases.length > 0 ? requestedCases : await fixtureCases();
const offlineEvaluator = createOracleEvaluator(offline);
const liveEvaluator = createOracleEvaluator(live);

process.stdout.write(
  `M2: ${cases.length} case(s) through the fixture backend and ${live.id} at ${loaded.config.backend.base_url}\n\n`,
);

const divergences: Divergence[] = [];
for (const caseId of cases) {
  // Sequential on purpose: the builds share one LocalCI queue, and interleaving them would measure
  // the queue rather than the exercises.
  const offlineResponse = await runEvaluation(request(caseId, "fixture"), offlineEvaluator);
  const liveResponse = await runEvaluation(request(caseId, live.id), liveEvaluator);
  const found = compareVerdicts(caseId, offlineResponse, liveResponse);
  divergences.push(...found);
  const verdict = `${liveResponse.status}/${String(liveResponse.strict_success)}`;
  process.stdout.write(
    found.length === 0
      ? `  ok        ${caseId} (${verdict})\n`
      : `  DIVERGES  ${caseId} (${verdict})\n${found.map((entry) => `              ${entry.detail}\n`).join("")}`,
  );
  // An infrastructure failure on the live side is not a verdict, so it cannot be read as agreement.
  if (liveResponse.status === "infra_failed" && offlineResponse.status !== "infra_failed") {
    process.stdout.write(
      `              live run was an infrastructure failure: ${liveResponse.failure_category ?? "unknown"}\n`,
    );
  }
}

if (divergences.length > 0) {
  process.stderr.write(
    `\nM2 FAILED: ${divergences.length} divergence(s) across ${cases.length} case(s).\n` +
      "Each one is either a fixture that mis-models the deployment or an endpoint that needs\n" +
      "reconciling. Record which in docs/WP8-RECONCILIATION.md before changing either side.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `\nM2 PASSED: the ${live.id} backend and the fixture backend agree on every verdict.\n` +
    "Coverage values were compared by availability, not value: coverage.statement measures a real\n" +
    "build, and coverage.branch stays not_applicable until the container backend (WP2c).\n",
);
