import { digestJson, sha256 } from "../core/canonical.ts";
import type { EvaluationResponse } from "../evaluation/contracts.ts";

type JsonRecord = Record<string, unknown>;

export const PUBLIC_DISCLOSURE_PROFILE = {
  id: "public",
  version: "1",
  fields: {
    adapter_parameters: "digest_only",
    runtime_commands: "digest_only",
    environment_variable_names: "digest_only",
    local_paths: "excluded",
    evaluator_messages: "excluded",
    evidence_payloads: "excluded",
    evidence_locations: "sha256_digest_only",
  },
} as const;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function select(source: JsonRecord, keys: string[]): JsonRecord {
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
}

export function publicRunProvenance(runManifest: unknown): unknown {
  const manifest = record(runManifest);
  const plan = record(manifest.plan);
  const target = record(plan.target);
  const provenance = record(manifest.provenance);
  const systems = Array.isArray(plan.systems) ? plan.systems : [];

  return {
    ...select(manifest, ["schema_version", "run_id", "run_instance_id", "created_at"]),
    plan: {
      ...select(plan, ["id", "benchmark", "dataset", "budget", "analysis", "cases", "attempts"]),
      target: {
        ...select(target, ["id", "adapter", "version", "revision"]),
        configuration_digest: digestJson({
          parameters: target.parameters ?? {},
        }),
      },
      systems: systems.map((value) => {
        const system = record(value);
        return {
          ...select(system, ["id", "name", "version", "revision", "factors"]),
          configuration_digest: digestJson({
            runtime: system.runtime ?? null,
            parameters: system.parameters ?? {},
          }),
        };
      }),
    },
    provenance: select(provenance, [
      "exgen_revision",
      "exgen_dirty",
      "exgen_source_tree_sha256",
      "bun_version",
      "bun_revision",
      "operating_system",
      "architecture",
      "lockfile_sha256",
      "generator_descriptors",
    ]),
  };
}

export function publicEvaluation(response: EvaluationResponse): EvaluationResponse {
  return {
    ...response,
    scores: response.scores.map(({ message: _message, evidence, ...score }) => ({
      ...score,
      evidence: evidence.map((reference) => `sha256:${sha256(reference)}`),
    })),
  };
}

export function publicEvidenceIndex(history: EvaluationResponse[]): unknown {
  return {
    schema_version: "1",
    disclosure_profile: PUBLIC_DISCLOSURE_PROFILE,
    references: history.flatMap((response, historyIndex) =>
      response.scores.flatMap((score) =>
        score.evidence.map((reference) => ({
          history_index: historyIndex,
          evaluation_id: response.evaluation_id,
          attempt_id: response.candidate.attempt_id,
          metric_id: score.metric_id,
          metric_version: score.metric_version,
          reference_sha256: sha256(reference),
          disposition: "restricted_or_external_not_embedded",
        })),
      ),
    ),
  };
}
