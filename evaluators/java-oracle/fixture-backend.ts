import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { evaluationFailureCategorySchema } from "../../src/evaluation/contracts.ts";
import { InfrastructureError } from "../shared/protocol.ts";
import {
  buildOutcomeSchema,
  type BuildBackend,
  type BuildJob,
  type BuildOutcome,
} from "./backend.ts";

/**
 * A recording is either a build result or a backend failure.
 *
 * The second form exists because a build that never returns has no build result, and the corpus has
 * to be able to assert that the evaluator reports `infra_failed` with no quality verdict.
 */
export const buildRecordingSchema = z.union([
  buildOutcomeSchema,
  z
    .object({
      infrastructure_failure: z
        .object({
          message: z.string().min(1),
          category: evaluationFailureCategorySchema.default("infrastructure.unavailable"),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * A backend that replays recorded build results, so the evaluator core can be exercised end to end
 * with no Artemis, no JVM and no network.
 *
 * It measures nothing: a recording is what a real backend was asserted to have produced, not what
 * one did produce. It must never appear in a study configuration, which is why its suite identity
 * says so and the recordings live outside any dataset.
 */
export class FixtureBuildBackend implements BuildBackend {
  readonly id = "fixture";

  constructor(private readonly recordingsDirectory: string) {}

  async build(job: BuildJob): Promise<BuildOutcome> {
    const path = resolve(join(this.recordingsDirectory, `${job.request.candidate.case_id}.json`));
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new InfrastructureError(
        `no recorded build result for case ${job.request.candidate.case_id}`,
      );
    }
    const parsed = buildRecordingSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new InfrastructureError(
        `recorded build result for case ${job.request.candidate.case_id} is not a valid build outcome`,
        "evaluator.protocol_error",
      );
    }
    if ("infrastructure_failure" in parsed.data) {
      throw new InfrastructureError(
        parsed.data.infrastructure_failure.message,
        parsed.data.infrastructure_failure.category,
      );
    }
    return parsed.data;
  }
}
