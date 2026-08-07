import { z } from "zod";
import { InfrastructureError } from "../shared/protocol.ts";
import type { BundleFile } from "../shared/bundle.ts";
import {
  buildAttestationSchema,
  type BuildAttestation,
  type BuildBackend,
  type BuildJob,
  type BuildOutcome,
  type SubmissionBuild,
  type TestCaseResult,
} from "./backend.ts";

/**
 * The Artemis LocalCI build backend: push the candidate's template, solution and tests into a fresh
 * unreleased exercise in a dedicated evaluation course, trigger both builds through ordinary
 * production APIs, poll for the results with the test-case breakdown and the coverage report, and
 * delete the exercise.
 *
 * Two invariants are enforced rather than intended. Every HTTP, timeout and agent failure below
 * raises `InfrastructureError`, so there is no path from "the queue was full" to "the exercise is
 * wrong". And `localCiBackendConfigSchema` rejects an evaluation course that is also a generation
 * course, so a generation run cannot observe evaluation state.
 *
 * A third rule -- that no sealed suite asset reaches Artemis -- is *not* enforced. It holds only
 * because `pushBundle` writes nothing but files the bundle reader returned, and the bundle reader
 * resolves artifact roots by string check rather than by real-path containment, so a candidate that
 * declares an artifact path through a symbolic link can put content from outside its own bundle on
 * the wire. Tightening `readCandidateBundle` is what would make the rule true.
 *
 * Every endpoint is overridable and `endpoints` is part of the evaluator's configuration digest, so
 * correcting a path against a deployment produces a new evaluator identity rather than a silent
 * change in what was measured. The exercise-creation and export paths match the ones the Artemis
 * adapter in this repository already uses; the repository-write, build-trigger and result-polling
 * paths are exercised by no other code here and by no live deployment.
 */

export const localCiEndpointsSchema = z
  .object({
    authenticate: z.string().min(1).default("/api/core/public/authenticate"),
    create_exercise: z
      .string()
      .min(1)
      .default("/api/programming/programming-exercises/setup?emptyRepositories=true"),
    delete_exercise: z
      .string()
      .min(1)
      .default(
        "/api/programming/programming-exercises/{exerciseId}?deleteStudentReposBuildPlans=true&deleteBaseReposBuildPlans=true",
      ),
    write_repository_file: z
      .string()
      .min(1)
      .default("/api/programming/repository/{participationId}/file?file={path}"),
    commit_repository: z
      .string()
      .min(1)
      .default("/api/programming/repository/{participationId}/commit"),
    trigger_builds: z
      .string()
      .min(1)
      .default("/api/programming/programming-exercises/{exerciseId}/trigger-instructor-build-all"),
    exercise_with_participations: z
      .string()
      .min(1)
      .default(
        "/api/programming/programming-exercises/{exerciseId}/with-template-and-solution-participation?withSubmissionResults=true",
      ),
    participation_results: z
      .string()
      .min(1)
      .default("/api/exercise/participations/{participationId}/results?withSubmissions=true"),
  })
  .strict();

export const localCiBackendConfigSchema = z
  .object({
    kind: z.literal("localci"),
    base_url: z.url(),
    /**
     * The evaluation course, which must differ from any course a generation run writes to. Nothing
     * here can see which courses those are, so the operator declares them in
     * `generation_course_ids` and the schema below checks the two do not overlap.
     */
    evaluation_course_id: z.number().int().positive(),
    generation_course_ids: z.array(z.number().int().positive()).default([]),
    exercise_short_name_prefix: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9]{0,8}$/)
      .default("exgeneval"),
    poll_interval_ms: z.number().int().min(250).max(60_000).default(5_000),
    build_timeout_ms: z
      .number()
      .int()
      .min(60_000)
      .max(6 * 60 * 60 * 1000)
      .default(15 * 60 * 1000),
    request_timeout_ms: z.number().int().min(1_000).max(600_000).default(60_000),
    delete_exercise_after_build: z.boolean().default(true),
    endpoints: localCiEndpointsSchema.prefault({}),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.generation_course_ids.includes(config.evaluation_course_id)) {
      context.addIssue({
        code: "custom",
        path: ["evaluation_course_id"],
        message:
          "the evaluation course must differ from every generation course, or a generation run can observe evaluation state",
      });
    }
  });

export type LocalCiBackendConfig = z.infer<typeof localCiBackendConfigSchema>;

const participationSchema = z.object({ id: z.number().int().positive() }).loose();

const exerciseSchema = z
  .object({
    id: z.number().int().positive(),
    shortName: z.string().min(1),
    templateParticipation: participationSchema.optional(),
    solutionParticipation: participationSchema.optional(),
  })
  .loose();

const resultSchema = z
  .object({
    id: z.number().int().positive(),
    completionDate: z.string().nullish(),
    successful: z.boolean().nullish(),
    score: z.number().nullish(),
    testCaseCount: z.number().int().nullish(),
    passedTestCaseCount: z.number().int().nullish(),
    codeIssueCount: z.number().int().nullish(),
    feedbacks: z
      .array(
        z
          .object({
            text: z.string().nullish(),
            testCase: z.object({ testName: z.string() }).loose().nullish(),
            positive: z.boolean().nullish(),
            detailText: z.string().nullish(),
            type: z.string().nullish(),
          })
          .loose(),
      )
      .nullish(),
    submission: z
      .object({
        buildFailed: z.boolean().nullish(),
        commitHash: z.string().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

const coverageEntrySchema = z
  .object({
    coveredLineCount: z.number().nullish(),
    missedLineCount: z.number().nullish(),
    lineCount: z.number().nullish(),
  })
  .loose();

export type LocalCiFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface LocalCiBackendOptions {
  config: LocalCiBackendConfig;
  /** Credential, read from an environment reference by the worker and never recorded. */
  authorization: string;
  fetchImplementation?: LocalCiFetch;
  /** Injected so the poll loop is testable without wall-clock delay. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        rejectPromise(new InfrastructureError("build polling was aborted", "evaluator.timeout"));
      },
      { once: true },
    );
  });
}

export class LocalCiBuildBackend implements BuildBackend {
  readonly id = "localci";

  private readonly config: LocalCiBackendConfig;
  private readonly authorization: string;
  private readonly fetchImplementation: LocalCiFetch;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(options: LocalCiBackendOptions) {
    this.config = options.config;
    this.authorization = options.authorization;
    this.fetchImplementation =
      options.fetchImplementation ??
      (async (url, init) => {
        const response = await fetch(url, init);
        return { status: response.status, text: () => response.text() };
      });
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    const shortName = this.shortName(job);
    let exercise: z.infer<typeof exerciseSchema> | null = null;
    try {
      exercise = await this.createExercise(shortName, signal);
      const template = exercise.templateParticipation?.id;
      const solution = exercise.solutionParticipation?.id;
      if (template === undefined || solution === undefined) {
        throw new InfrastructureError(
          "Artemis created an exercise without template and solution participations",
        );
      }
      await this.pushBundle(job, template, solution, signal);
      await this.triggerBuilds(exercise.id, signal);
      const [templateResult, solutionResult] = await Promise.all([
        this.awaitResult(template, signal),
        this.awaitResult(solution, signal),
      ]);
      return {
        template: toSubmissionBuild(templateResult),
        solution: toSubmissionBuild(solutionResult),
        attestation: this.attestation(),
      };
    } finally {
      if (exercise !== null && this.config.delete_exercise_after_build) {
        await this.deleteExercise(exercise.id, signal).catch(() => undefined);
      }
    }
  }

  /**
   * Without this, an evaluator killed mid-build leaves an orphaned exercise behind and the short
   * name it would replay under is already taken, so that evaluation can never be retried.
   */
  async recover(job: BuildJob, signal: AbortSignal): Promise<void> {
    const shortName = this.shortName(job);
    const existing = await this.findExercise(shortName, signal);
    if (existing !== null) {
      await this.deleteExercise(existing.id, signal);
    }
  }

  /**
   * A deterministic short name derived from the evaluation ID, so a replay addresses the same remote
   * exercise instead of creating a second one.
   */
  private shortName(job: BuildJob): string {
    return `${this.config.exercise_short_name_prefix}${job.request.evaluation_id.slice(0, 10)}`;
  }

  private attestation(): BuildAttestation {
    // No Artemis endpoint reports any of these; see `buildAttestationSchema` for why they are
    // recorded as null rather than omitted.
    return buildAttestationSchema.parse({
      backend_id: this.id,
      artemis_revision: null,
      build_agent_image: null,
      build_script_revision: null,
      unattested: ["artemis_revision", "build_agent_image", "build_script_revision"],
    });
  }

  private endpoint(template: string, values: Record<string, string | number>): string {
    const path = template.replaceAll(/\{(\w+)\}/g, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new InfrastructureError(`endpoint template references unknown placeholder ${key}`);
      }
      return encodeURIComponent(String(value));
    });
    return `${this.config.base_url.replace(/\/+$/, "")}${path}`;
  }

  private async call<T>(
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: unknown,
    signal: AbortSignal,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.request_timeout_ms);
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImplementation(url, {
        method,
        headers: {
          Authorization: this.authorization,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new InfrastructureError(
        `Artemis request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    if (status < 200 || status >= 300) {
      throw new InfrastructureError(`Artemis returned HTTP ${status}`);
    }
    if (text.trim().length === 0) {
      return schema.parse(undefined);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new InfrastructureError("Artemis returned a non-JSON response");
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new InfrastructureError(
        "Artemis returned a response the evaluator does not recognise; reconcile the endpoint contract (WP8)",
        "evaluator.protocol_error",
      );
    }
    return parsed.data;
  }

  private async createExercise(
    shortName: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof exerciseSchema>> {
    const existing = await this.findExercise(shortName, signal);
    if (existing !== null) {
      return existing;
    }
    const exercise = await this.call(
      this.endpoint(this.config.endpoints.create_exercise, {}),
      "POST",
      {
        title: `exgen evaluation ${shortName}`,
        shortName,
        course: { id: this.config.evaluation_course_id },
        programmingLanguage: "JAVA",
        // Unreleased: an evaluation exercise must never be visible to a participant.
        releaseDate: null,
        allowOfflineIde: false,
        publishBuildPlanUrl: false,
      },
      signal,
      exerciseSchema,
    );
    if (exercise.shortName !== shortName) {
      throw new InfrastructureError("Artemis created an exercise with an unexpected short name");
    }
    return exercise;
  }

  private async findExercise(
    shortName: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof exerciseSchema> | null> {
    const exercises = await this.call(
      this.endpoint("/api/programming/courses/{courseId}/programming-exercises", {
        courseId: this.config.evaluation_course_id,
      }),
      "GET",
      undefined,
      signal,
      z.array(exerciseSchema),
    );
    return exercises.find((exercise) => exercise.shortName === shortName) ?? null;
  }

  private async pushBundle(
    job: BuildJob,
    templateParticipation: number,
    solutionParticipation: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Only files the bundle reader returned cross this boundary; nothing here opens a suite asset.
    await this.pushFiles(templateParticipation, job.bundle.template, signal);
    await this.pushFiles(solutionParticipation, job.bundle.solution, signal);
    // The test repository is owned by the exercise; Artemis exposes it through the solution
    // participation's linked test repository, so tests are pushed with the same participation.
    await this.pushFiles(solutionParticipation, job.bundle.tests, signal, "tests/");
  }

  private async pushFiles(
    participationId: number,
    files: BundleFile[],
    signal: AbortSignal,
    prefix = "",
  ): Promise<void> {
    for (const file of files) {
      await this.call(
        this.endpoint(this.config.endpoints.write_repository_file, {
          participationId,
          path: `${prefix}${file.path}`,
        }),
        "PUT",
        { content: file.content },
        signal,
        z.unknown(),
      );
    }
    await this.call(
      this.endpoint(this.config.endpoints.commit_repository, { participationId }),
      "POST",
      undefined,
      signal,
      z.unknown(),
    );
  }

  private async triggerBuilds(exerciseId: number, signal: AbortSignal): Promise<void> {
    await this.call(
      this.endpoint(this.config.endpoints.trigger_builds, { exerciseId }),
      "POST",
      undefined,
      signal,
      z.unknown(),
    );
  }

  private async deleteExercise(exerciseId: number, signal: AbortSignal): Promise<void> {
    await this.call(
      this.endpoint(this.config.endpoints.delete_exercise, { exerciseId }),
      "DELETE",
      undefined,
      signal,
      z.unknown(),
    );
  }

  private async awaitResult(
    participationId: number,
    signal: AbortSignal,
  ): Promise<z.infer<typeof resultSchema>> {
    const deadline = this.now() + this.config.build_timeout_ms;
    for (;;) {
      const results = await this.call(
        this.endpoint(this.config.endpoints.participation_results, { participationId }),
        "GET",
        undefined,
        signal,
        z.array(resultSchema),
      );
      const completed = results
        .filter((result) => typeof result.completionDate === "string")
        .sort((left, right) => left.id - right.id)
        .at(-1);
      if (completed !== undefined) {
        return completed;
      }
      if (this.now() >= deadline) {
        // A build that never finishes is infrastructure, not a failing exercise.
        throw new InfrastructureError(
          `LocalCI produced no result for participation ${participationId} within the build timeout`,
          "evaluator.timeout",
        );
      }
      await this.sleep(this.config.poll_interval_ms, signal);
    }
  }
}

/** Map one Artemis result onto the backend-agnostic submission build contract. */
export function toSubmissionBuild(result: z.infer<typeof resultSchema>): SubmissionBuild {
  const buildFailed = result.submission?.buildFailed === true;
  const feedbacks = result.feedbacks ?? [];
  const testCases: TestCaseResult[] = feedbacks
    .filter((feedback) => feedback.testCase?.testName !== undefined)
    .map((feedback) => ({
      name: feedback.testCase?.testName ?? "",
      passed: feedback.positive === true,
      ...(feedback.detailText ? { message: feedback.detailText.slice(0, 500) } : {}),
    }));
  const diagnostics = feedbacks
    .filter((feedback) => feedback.testCase?.testName === undefined && feedback.text)
    .map((feedback) => String(feedback.text).slice(0, 500))
    .slice(0, 32);
  return {
    compiled: !buildFailed,
    // A build that failed to compile ran no tests; a build that compiled and reported at least one
    // test case ran them. Anything else is unknown and reported as "not executed" rather than as a
    // pass rate over an empty suite.
    tests_executed: !buildFailed && testCases.length > 0,
    test_cases: testCases,
    coverage: coverageFrom(result),
    diagnostics,
  };
}

function coverageFrom(result: z.infer<typeof resultSchema>): SubmissionBuild["coverage"] {
  const reports = (result as { coverageFileReportsByTestCaseName?: unknown })
    .coverageFileReportsByTestCaseName;
  if (typeof reports !== "object" || reports === null) {
    return null;
  }
  let covered = 0;
  let total = 0;
  for (const entry of Object.values(reports as Record<string, unknown>)) {
    const parsed = coverageEntrySchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    covered += parsed.data.coveredLineCount ?? 0;
    total +=
      parsed.data.lineCount ??
      (parsed.data.coveredLineCount ?? 0) + (parsed.data.missedLineCount ?? 0);
  }
  if (total === 0) {
    return null;
  }
  // Artemis reports line coverage through JaCoCo; branch coverage is not exposed by this endpoint.
  return { statement: Math.min(1, covered / total), branch: null };
}
