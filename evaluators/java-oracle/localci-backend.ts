import { z } from "zod";
import { sha256 } from "../../src/core/canonical.ts";
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
 * Three invariants are enforced rather than intended. Every HTTP, timeout and agent failure below
 * raises `InfrastructureError`, so there is no path from "the queue was full" to "the exercise is
 * wrong". `localCiBackendConfigSchema` rejects an evaluation course that is also a generation course,
 * so a generation run cannot observe evaluation state. And no sealed suite asset can reach Artemis:
 * `pushBundle` writes nothing but files `readCandidateBundle` returned, and that reader resolves each
 * artifact root lexically inside the bundle (rejecting absolute paths and `..`), rejects a symbolic
 * link at every component from the bundle root down, and rejects one again at every entry of the
 * walk. A candidate therefore cannot name a path whose bytes come from outside its own bundle.
 *
 * Authentication mirrors the generation adapter's flow rather than importing it: username and
 * password to `authenticate`, then the returned `jwt` cookie on every later request. The credential
 * is read from the environment by the worker and never enters a URL, the configuration digest or the
 * journal. It is mirrored rather than shared because an evaluator must not depend on the client of
 * the system it measures.
 *
 * Every endpoint is overridable and `endpoints` is part of the evaluator's configuration digest, so
 * correcting a path against a deployment produces a new evaluator identity rather than a silent
 * change in what was measured. The authenticate, exercise-creation, course-listing and export paths
 * match the ones the Artemis adapter in this repository already uses against a live deployment. The
 * repository-write, test-repository-write, build-trigger and result-polling paths are exercised by no
 * live deployment here: they are written against Artemis's REST conventions and **must** be
 * reconciled in M2. Correcting one is a configuration change, by design.
 */

export const localCiEndpointsSchema = z
  .object({
    authenticate: z.string().min(1).default("/api/core/public/authenticate"),
    list_course_exercises: z
      .string()
      .min(1)
      .default("/api/programming/courses/{courseId}/programming-exercises"),
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
    /**
     * The test repository has no participation: it belongs to the exercise, so it is addressed by
     * exercise id. Pushing tests through a participation would put test sources inside the
     * template or solution module and compile them as assignment code.
     */
    write_test_repository_file: z
      .string()
      .min(1)
      .default("/api/programming/test-repository/{exerciseId}/file?file={path}"),
    commit_test_repository: z
      .string()
      .min(1)
      .default("/api/programming/test-repository/{exerciseId}/commit"),
    trigger_builds: z
      .string()
      .min(1)
      .default("/api/programming/programming-exercises/{exerciseId}/trigger-instructor-build-all"),
    /**
     * Read after creation for two reasons: it is the authoritative source of the template and
     * solution participation ids, and it carries the `buildConfig` the attestation is built from.
     */
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

/**
 * What the deployment reports about how it will build. `buildPlanConfiguration` is a JSON *string*
 * holding the phases and the agent image, which is why it is parsed separately below rather than
 * being modelled inline.
 */
const buildConfigSchema = z
  .object({
    branch: z.string().min(1).nullish(),
    buildPlanConfiguration: z.string().nullish(),
    timeoutSeconds: z.number().nullish(),
  })
  .loose();

const buildPlanConfigurationSchema = z
  .object({
    dockerImage: z.string().min(1).nullish(),
    phases: z.array(z.object({ name: z.string().min(1), script: z.string() }).loose()).nullish(),
  })
  .loose();

const exerciseSchema = z
  .object({
    id: z.number().int().positive(),
    shortName: z.string().min(1),
    projectKey: z.string().min(1).nullish(),
    testRepositoryUri: z.string().min(1).nullish(),
    buildConfig: buildConfigSchema.nullish(),
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
) => Promise<{
  status: number;
  text: () => Promise<string>;
  /** Needed only by `authenticate`, which reads the session out of `Set-Cookie`. */
  headers?: { getSetCookie: () => string[] };
}>;

/** Username and password for the dedicated evaluation-course account. Never logged, never in a URL. */
export interface LocalCiCredentials {
  username: string;
  password: string;
}

export interface LocalCiBackendOptions {
  config: LocalCiBackendConfig;
  /** Credentials, read from environment references by the worker and never recorded. */
  credentials: LocalCiCredentials;
  fetchImplementation?: LocalCiFetch;
  /** Injected so the poll loop is testable without wall-clock delay. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** The `jwt` cookie Artemis sets on a successful authentication, if it set one. */
export function sessionCookie(setCookie: string[]): string | undefined {
  for (const value of setCookie) {
    const match = value.match(/^\s*jwt=([^;]+)/);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
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
  private readonly credentials: LocalCiCredentials;
  private readonly fetchImplementation: LocalCiFetch;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  /** The `jwt` session established by `authenticate`, held only for this process's lifetime. */
  private session: string | undefined;

  constructor(options: LocalCiBackendOptions) {
    this.config = options.config;
    this.credentials = options.credentials;
    this.fetchImplementation =
      options.fetchImplementation ??
      (async (url, init) => {
        const response = await fetch(url, init);
        return {
          status: response.status,
          text: () => response.text(),
          headers: { getSetCookie: () => response.headers.getSetCookie() },
        };
      });
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    await this.authenticate(signal);
    const shortName = this.shortName(job);
    let exercise: z.infer<typeof exerciseSchema> | null = null;
    try {
      exercise = await this.createExercise(shortName, signal);
      // Re-read it: this is the authoritative source of the participation ids and of the build
      // configuration the attestation records. Assigning before the read keeps the exercise in
      // scope for cleanup if the read itself fails.
      exercise = await this.readExercise(exercise.id, signal);
      const template = exercise.templateParticipation?.id;
      const solution = exercise.solutionParticipation?.id;
      if (template === undefined || solution === undefined) {
        throw new InfrastructureError(
          "Artemis created an exercise without template and solution participations",
        );
      }
      await this.pushBundle(job, exercise.id, template, solution, signal);
      await this.triggerBuilds(exercise.id, signal);
      const [templateResult, solutionResult] = await Promise.all([
        this.awaitResult(template, signal),
        this.awaitResult(solution, signal),
      ]);
      return {
        template: toSubmissionBuild(templateResult),
        solution: toSubmissionBuild(solutionResult),
        attestation: this.attestation(exercise),
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
    await this.authenticate(signal);
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

  /**
   * Everything here is read out of the exercise's own `buildConfig`, so an attestation is only ever
   * as specific as the deployment's answer was. A field the deployment did not report stays null and
   * is named in `unattested`; nothing is inferred from a default or a constant.
   *
   * `artemis_revision` is always unattested: no endpoint this backend uses reports the Artemis
   * revision, and neighbouring evidence (a course id, an exercise id) is not a version of the server.
   */
  private attestation(exercise: z.infer<typeof exerciseSchema>): BuildAttestation {
    const plan = exercise.buildConfig?.buildPlanConfiguration ?? null;
    let image: string | null = null;
    let phases: Array<{ name: string; script: string }> = [];
    if (plan !== null) {
      // `buildPlanConfiguration` is JSON inside a JSON string. A deployment that changes its shape
      // must degrade to "unattested", never to a wrong attestation, so both steps stay tolerant.
      let decoded: unknown;
      try {
        decoded = JSON.parse(plan);
      } catch {
        decoded = undefined;
      }
      const parsed = buildPlanConfigurationSchema.safeParse(decoded);
      if (parsed.success) {
        image = parsed.data.dockerImage ?? null;
        phases = (parsed.data.phases ?? []).map((phase) => ({
          name: phase.name,
          script: phase.script,
        }));
      }
    }
    const branch = exercise.buildConfig?.branch ?? null;
    // A content digest of the script the deployment reported. Artemis exposes the build plan but no
    // version of it, so this identifies it by content; `buildAttestationSchema` says as much.
    const scriptRevision = plan === null ? null : `sha256:${sha256(plan)}`;
    return buildAttestationSchema.parse({
      backend_id: this.id,
      artemis_revision: null,
      build_agent_image: image,
      build_script_revision: scriptRevision,
      build_phase_scripts: phases,
      build_branch: branch,
      unattested: [
        "artemis_revision",
        ...(image === null ? ["build_agent_image"] : []),
        ...(scriptRevision === null ? ["build_script_revision"] : []),
        ...(phases.length === 0 ? ["build_phase_scripts"] : []),
        ...(branch === null ? ["build_branch"] : []),
      ],
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
          ...(this.session === undefined ? {} : { cookie: `jwt=${this.session}` }),
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

  /**
   * Establish the session, mirroring the generation adapter's flow: a password grant to Artemis's
   * public authenticate endpoint, then the `jwt` cookie it sets on every later request.
   *
   * The credential travels in a request body, never a query string, so it cannot reach a log that
   * records URLs. Every failure is infrastructure: a rejected password is not a fact about the
   * exercise under measurement.
   */
  private async authenticate(signal: AbortSignal): Promise<void> {
    if (this.session !== undefined) {
      return;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.request_timeout_ms);
    let status: number;
    let cookie: string | undefined;
    try {
      const response = await this.fetchImplementation(
        this.endpoint(this.config.endpoints.authenticate, {}),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            username: this.credentials.username,
            password: this.credentials.password,
            rememberMe: false,
          }),
          signal: controller.signal,
        },
      );
      status = response.status;
      cookie = sessionCookie(response.headers?.getSetCookie() ?? []);
    } catch (error) {
      throw new InfrastructureError(
        `Artemis authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    if (status < 200 || status >= 300) {
      throw new InfrastructureError(`Artemis authentication returned HTTP ${status}`);
    }
    if (cookie === undefined) {
      throw new InfrastructureError("Artemis authentication did not return its jwt cookie");
    }
    this.session = cookie;
  }

  private async readExercise(
    exerciseId: number,
    signal: AbortSignal,
  ): Promise<z.infer<typeof exerciseSchema>> {
    return this.call(
      this.endpoint(this.config.endpoints.exercise_with_participations, { exerciseId }),
      "GET",
      undefined,
      signal,
      exerciseSchema,
    );
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
      this.endpoint(this.config.endpoints.list_course_exercises, {
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
    exerciseId: number,
    templateParticipation: number,
    solutionParticipation: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Only files the bundle reader returned cross this boundary; nothing here opens a suite asset.
    for (const [participationId, files] of [
      [templateParticipation, job.bundle.template],
      [solutionParticipation, job.bundle.solution],
    ] as const) {
      await this.pushFiles(
        files,
        signal,
        (path) =>
          this.endpoint(this.config.endpoints.write_repository_file, { participationId, path }),
        this.endpoint(this.config.endpoints.commit_repository, { participationId }),
      );
    }
    // The test repository belongs to the exercise, not to a participation, so it is addressed by
    // exercise id. Its paths are the repository's own: the tests artifact already carries the
    // `pom.xml` and `test/` layout the build expects, so prefixing them -- as this backend once did
    // by pushing them through the solution participation -- would nest the suite inside the solution
    // module, where Maven compiles it as assignment code instead of as the exercise's tests.
    await this.pushFiles(
      job.bundle.tests,
      signal,
      (path) =>
        this.endpoint(this.config.endpoints.write_test_repository_file, { exerciseId, path }),
      this.endpoint(this.config.endpoints.commit_test_repository, { exerciseId }),
    );
  }

  private async pushFiles(
    files: BundleFile[],
    signal: AbortSignal,
    writeUrl: (path: string) => string,
    commitUrl: string,
  ): Promise<void> {
    for (const file of files) {
      await this.call(writeUrl(file.path), "PUT", { content: file.content }, signal, z.unknown());
    }
    await this.call(commitUrl, "POST", undefined, signal, z.unknown());
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
