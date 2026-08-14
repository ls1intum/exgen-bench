import { z } from "zod";
import { sha256 } from "../../src/core/canonical.ts";
import { InfrastructureError } from "../shared/protocol.ts";
import type { EvaluationFailureCategory } from "../../src/evaluation/contracts.ts";
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
 * The Artemis LocalCI build backend: create a fresh unreleased exercise in a dedicated evaluation
 * course, make its three repositories equal to the candidate's template, solution and tests, trigger
 * both builds through ordinary production APIs, poll for the results and their test-case breakdown,
 * and delete the exercise.
 *
 * Four invariants are enforced rather than intended.
 *
 * Every HTTP, timeout and agent failure below raises `InfrastructureError`, so there is no path from
 * "the queue was full" to "the exercise is wrong". This extends to a build Artemis *completed*:
 * a build LocalCI stopped at its timeout is reported as `buildFailed` with no feedbacks, which is
 * indistinguishable from a build whose code does not compile, so `assertBuildRan` reads the build log
 * of a failed build and refuses to map one the infrastructure killed.
 *
 * The verdict is a function of the bundle, never of the seed. Artemis builds the exercise it seeds at
 * creation time, so `build` baselines the *submissions* that exist before anything is pushed and
 * accepts only results from submissions created after: without that, a build of Artemis's own
 * template can be read as this evaluation's build.
 *
 * `localCiBackendConfigSchema` rejects an evaluation course that is also a generation course, so a
 * generation run cannot observe evaluation state.
 *
 * And no sealed suite asset can reach Artemis: `pushBundle` writes nothing but files
 * `readCandidateBundle` returned, and that reader resolves each artifact root lexically inside the
 * bundle (rejecting absolute paths and `..`), rejects a symbolic link at every component from the
 * bundle root down, and rejects one again at every entry of the walk. A candidate therefore cannot
 * name a path whose bytes come from outside its own bundle.
 *
 * Authentication mirrors the generation adapter's flow rather than importing it: username and
 * password to `authenticate`, then the returned `jwt` cookie on every later request. The credential
 * is read from the environment by the worker and never enters a URL, the configuration digest or the
 * journal. It is mirrored rather than shared because an evaluator must not depend on the client of
 * the system it measures.
 *
 * Every endpoint is overridable and `endpoints` is part of the evaluator's configuration digest, so
 * correcting a path against a deployment produces a new evaluator identity rather than a silent
 * change in what was measured. Every path here has now been exercised against a live Artemis
 * (PR #13156) and reconciled against what it actually answers; `docs/WP8-M2-LIVE.md` §4 and §6 record
 * each shape before and after, and which corrections were configuration and which were code.
 */

export const localCiEndpointsSchema = z
  .object({
    authenticate: z.string().min(1).default("/api/core/public/authenticate"),
    list_course_exercises: z
      .string()
      .min(1)
      .default("/api/programming/courses/{courseId}/programming-exercises"),
    /**
     * `emptyRepositories=false` is deliberate. On Artemis PR #13156 the `true` path means "this
     * creation is an AI generation": it calls `validateAiGenerationPreconditions`, which rejects the
     * request with `hyperionDisabled` unless the Hyperion module is on, and Hyperion requires an LLM
     * provider this model-free oracle must not depend on. So the exercise is created with Artemis's
     * seeded Java template and `reconcileRepository` below then makes each repository equal to the
     * bundle exactly.
     */
    create_exercise: z
      .string()
      .min(1)
      .default("/api/programming/programming-exercises/setup?emptyRepositories=false"),
    delete_exercise: z
      .string()
      .min(1)
      .default(
        "/api/programming/programming-exercises/{exerciseId}?deleteStudentReposBuildPlans=true&deleteBaseReposBuildPlans=true",
      ),
    /**
     * Listing then deleting is what makes the build a function of the bundle rather than of the
     * seed: every seeded file the bundle does not contain is removed before the bundle is written.
     */
    list_repository_files: z
      .string()
      .min(1)
      .default("/api/programming/repository/{participationId}/files"),
    /**
     * `POST`, and the file content is the **raw** request body -- not a JSON `{content}` envelope.
     * There is no `PUT .../file` route; sending one returns 405. Artemis also refuses to create a
     * path that already exists, which is why reconciliation deletes before it writes.
     */
    write_repository_file: z
      .string()
      .min(1)
      .default("/api/programming/repository/{participationId}/file?file={path}"),
    delete_repository_file: z
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
    list_test_repository_files: z
      .string()
      .min(1)
      .default("/api/programming/test-repository/{exerciseId}/files"),
    write_test_repository_file: z
      .string()
      .min(1)
      .default("/api/programming/test-repository/{exerciseId}/file?file={path}"),
    delete_test_repository_file: z
      .string()
      .min(1)
      .default("/api/programming/test-repository/{exerciseId}/file?file={path}"),
    commit_test_repository: z
      .string()
      .min(1)
      .default("/api/programming/test-repository/{exerciseId}/commit"),
    /**
     * Per participation, not per exercise. The exercise-level `trigger-instructor-build-all` answers
     * 200 but only loads *student* participations, of which an evaluation exercise has none, so it
     * builds nothing at all -- a silent no-op is a worse failure than an error.
     */
    trigger_build: z
      .string()
      .min(1)
      .default(
        "/api/programming/participations/{participationId}/trigger-build?submissionType=INSTRUCTOR",
      ),
    /**
     * Read after creation for two reasons: it is the authoritative source of the template and
     * solution participation ids, and it carries the `buildConfig` the attestation is built from.
     *
     * The `with-template-and-solution-participation` variant does *not* carry `buildConfig` --
     * that association is lazy and never fetched there -- so reading it from this plain exercise
     * endpoint is what keeps the attestation from degrading to fully unattested.
     */
    exercise_with_participations: z
      .string()
      .min(1)
      .default("/api/programming/programming-exercises/{exerciseId}"),
    /**
     * Results are exercise-scoped, not participation-scoped: no
     * `participations/{id}/results` route exists on any Artemis base path (both the `api/exercise`
     * and `api/assessment` spellings answer 404). Results arrive nested as
     * `templateParticipation.submissions[].results[]`.
     */
    exercise_results: z
      .string()
      .min(1)
      .default(
        "/api/programming/programming-exercises/{exerciseId}/with-template-and-solution-participation?withSubmissionResults=true",
      ),
    /**
     * The nested results carry counts but no feedbacks, so the per-test breakdown the verdict is
     * computed from needs this second call per result.
     */
    result_details: z
      .string()
      .min(1)
      .default("/api/assessment/participations/{participationId}/results/{resultId}/details"),
    /**
     * Read only for a build that failed, to tell *why* it failed. A build LocalCI killed and a build
     * whose code does not compile are indistinguishable in the result -- both are `buildFailed` with
     * no feedbacks -- and calling the first one a quality verdict would report an exhausted queue as
     * a broken exercise.
     */
    participation_build_logs: z
      .string()
      .min(1)
      .default("/api/programming/participations/{participationId}/buildlogs?resultId={resultId}"),
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

/**
 * The package the created exercise declares. It only shapes Artemis's seeded template, which
 * `reconcileRepository` deletes before the bundle is written, so it can never reach a build or a
 * verdict -- but Artemis rejects an exercise without a valid one.
 */
const EVALUATION_PACKAGE_NAME = "de.tum.cit.aet.exgen";

/** Artemis's repository listing: repository-relative path to `FILE` or `FOLDER`. */
const repositoryListingSchema = z.record(z.string(), z.enum(["FILE", "FOLDER"]));

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

const buildLogEntrySchema = z.object({ log: z.string().nullish() }).loose();

/**
 * Signatures in a build log that mean the build did not run to completion for reasons that say
 * nothing about the exercise. Each maps to the failure category it is reported under.
 *
 * These are matched against Artemis's own log text because the result carries no status a
 * non-administrator can read: `BuildStatus.TIMEOUT` exists, but only the admin build-queue endpoints
 * expose it, and an evaluator should not need administrator rights to tell a timeout from a compile
 * error. The strings below were taken from a live deployment, not from the source.
 */
const INFRASTRUCTURE_BUILD_FAILURES: Array<{
  pattern: RegExp;
  category: EvaluationFailureCategory;
  describe: string;
}> = [
  {
    pattern: /Timed out after \d+ seconds|java\.util\.concurrent\.TimeoutException/,
    category: "evaluator.timeout",
    describe: "LocalCI stopped the build at its timeout",
  },
  {
    pattern: /temporary infrastructure issue while preparing the build environment/,
    category: "infrastructure.unavailable",
    describe: "the build agent could not prepare the build environment",
  },
];

/** One entry of the `Feedback[]` the result-details endpoint returns. */
const feedbackSchema = z
  .object({
    text: z.string().nullish(),
    testCase: z.object({ testName: z.string() }).loose().nullish(),
    positive: z.boolean().nullish(),
    detailText: z.string().nullish(),
    type: z.string().nullish(),
  })
  .loose();

export type Feedback = z.infer<typeof feedbackSchema>;

/**
 * A result as Artemis nests it under a submission. It carries counts but no feedbacks: the per-test
 * breakdown comes from the separate details endpoint, which is why `toSubmissionBuild` takes the
 * two together rather than reading one object.
 */
const resultSchema = z
  .object({
    id: z.number().int().positive(),
    completionDate: z.string().nullish(),
    successful: z.boolean().nullish(),
    score: z.number().nullish(),
    testCaseCount: z.number().int().nullish(),
    passedTestCaseCount: z.number().int().nullish(),
    codeIssueCount: z.number().int().nullish(),
  })
  .loose();

const submissionSchema = z
  .object({
    id: z.number().int().positive(),
    buildFailed: z.boolean().nullish(),
    commitHash: z.string().nullish(),
    results: z.array(resultSchema).nullish(),
  })
  .loose();

/** A template or solution participation as it arrives inside the exercise, with its submissions. */
const participationWithSubmissionsSchema = z
  .object({
    id: z.number().int().positive(),
    submissions: z.array(submissionSchema).nullish(),
  })
  .loose();

const exerciseResultsSchema = z
  .object({
    id: z.number().int().positive(),
    templateParticipation: participationWithSubmissionsSchema.optional(),
    solutionParticipation: participationWithSubmissionsSchema.optional(),
  })
  .loose();

/**
 * One completed build: the result Artemis reported, the submission it belongs to (which is where
 * `buildFailed` lives), and the feedbacks fetched separately.
 */
export interface CompletedBuild {
  result: z.infer<typeof resultSchema>;
  submission: z.infer<typeof submissionSchema>;
  feedbacks: Feedback[];
}

export type LocalCiFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  /** Needed only by `authenticate`, which reads the session out of `Set-Cookie`. */
  headers?: { getSetCookie: () => string[] };
}>;

/**
 * A request body. JSON for the ordinary REST calls; `raw` for Artemis's file-write endpoints, which
 * treat the request body as the file's content rather than as a JSON envelope.
 */
type RequestBody = { json: unknown } | { raw: string };

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
      // Every submission that exists now is a submission of Artemis's seeded template, because
      // nothing of the candidate's has been written yet. Capturing them here, *before* the push, is
      // what makes the verdict a function of the bundle: a build of the seed can then never be
      // mistaken for this evaluation's build, however the two interleave in the queue.
      const baseline = await this.submissionIds(exercise.id, signal);
      await this.pushBundle(job, exercise.id, template, solution, signal);
      await Promise.all([this.triggerBuild(template, signal), this.triggerBuild(solution, signal)]);
      const { template: templateBuild, solution: solutionBuild } = await this.awaitResults(
        exercise.id,
        baseline,
        signal,
      );
      // A build LocalCI stopped is not a fact about the exercise. Checked before anything is mapped,
      // so an exhausted queue can never reach the metric contract as "the code does not compile".
      await Promise.all([
        this.assertBuildRan(template, templateBuild, signal),
        this.assertBuildRan(solution, solutionBuild, signal),
      ]);
      return {
        template: toSubmissionBuild(templateBuild),
        solution: toSubmissionBuild(solutionBuild),
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
    body: RequestBody | undefined,
    signal: AbortSignal,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.request_timeout_ms);
    let status: number;
    let text: string;
    // Artemis's file-write endpoints read the request body as the file's bytes, so a JSON envelope
    // would be written into the repository verbatim. `raw` sends the content as-is.
    const encoded =
      body === undefined
        ? undefined
        : "raw" in body
          ? { contentType: "text/plain; charset=utf-8", payload: body.raw }
          : { contentType: "application/json", payload: JSON.stringify(body.json) };
    try {
      const response = await this.fetchImplementation(url, {
        method,
        headers: {
          ...(this.session === undefined ? {} : { cookie: `jwt=${this.session}` }),
          Accept: "application/json",
          ...(encoded === undefined ? {} : { "Content-Type": encoded.contentType }),
        },
        ...(encoded === undefined ? {} : { body: encoded.payload }),
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
        json: {
          // `Exercise` is polymorphic (`@JsonTypeInfo(use = NAME, property = "type")`), so without
          // this the body fails to deserialise before any validator runs and Artemis answers a bare
          // "Failed to read request".
          type: "programming",
          title: `exgen evaluation ${shortName}`,
          shortName,
          course: { id: this.config.evaluation_course_id },
          programmingLanguage: "JAVA",
          // Java under LocalCI accepts PLAIN_MAVEN, MAVEN_MAVEN, PLAIN_GRADLE, GRADLE_GRADLE and
          // MAVEN_BLACKBOX; the bundles carry a `pom.xml`, so PLAIN_MAVEN is the matching one.
          projectType: "PLAIN_MAVEN",
          // Only ever used for the seeded template, which `reconcileRepository` deletes before the
          // bundle is written, so it cannot reach the build. Artemis rejects the request without it.
          packageName: EVALUATION_PACKAGE_NAME,
          // Unreleased: an evaluation exercise must never be visible to a participant.
          releaseDate: null,
          // Artemis requires at least one participation mode. The online editor is the inert
          // choice: nothing here opens it, and it keeps the exercise out of an offline IDE.
          allowOnlineEditor: true,
          allowOfflineIde: false,
          allowOnlineIde: false,
          staticCodeAnalysisEnabled: false,
          maxPoints: 10,
          assessmentType: "AUTOMATIC",
          // Validation dereferences `buildConfig` unconditionally, so it cannot be omitted. Leaving
          // `buildPlanConfiguration` null makes Artemis fill in its own default build plan, which is
          // what the attestation then reports.
          buildConfig: {
            checkoutSolutionRepository: false,
            timeoutSeconds: 0,
            buildPlanConfiguration: null,
          },
        },
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
      await this.reconcileRepository(
        files,
        signal,
        this.endpoint(this.config.endpoints.list_repository_files, { participationId }),
        (path) =>
          this.endpoint(this.config.endpoints.delete_repository_file, { participationId, path }),
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
    await this.reconcileRepository(
      job.bundle.tests,
      signal,
      this.endpoint(this.config.endpoints.list_test_repository_files, { exerciseId }),
      (path) =>
        this.endpoint(this.config.endpoints.delete_test_repository_file, { exerciseId, path }),
      (path) =>
        this.endpoint(this.config.endpoints.write_test_repository_file, { exerciseId, path }),
      this.endpoint(this.config.endpoints.commit_test_repository, { exerciseId }),
    );
  }

  /**
   * Make one repository equal to the bundle's artifact, exactly.
   *
   * The exercise is created with `emptyRepositories=false`, so each repository arrives carrying
   * Artemis's seeded Java template. Every seeded file is deleted before the bundle is written, so a
   * verdict is a function of the candidate's artifacts and never of whatever the seed happened to
   * contain. Deleting first is also what makes the write legal at all: Artemis refuses to create a
   * path that already exists.
   *
   * Only `FILE` entries are deleted. Folders disappear with their contents in git, and asking
   * Artemis to delete a folder entry that a delete of its last file already removed is an error.
   */
  private async reconcileRepository(
    files: BundleFile[],
    signal: AbortSignal,
    listUrl: string,
    deleteUrl: (path: string) => string,
    writeUrl: (path: string) => string,
    commitUrl: string,
  ): Promise<void> {
    const existing = await this.call(listUrl, "GET", undefined, signal, repositoryListingSchema);
    for (const [path, kind] of Object.entries(existing)) {
      if (kind === "FILE") {
        await this.call(deleteUrl(path), "DELETE", undefined, signal, z.unknown());
      }
    }
    for (const file of files) {
      // Raw body: this endpoint writes the request body into the repository as the file's bytes.
      await this.call(writeUrl(file.path), "POST", { raw: file.content }, signal, z.unknown());
    }
    await this.call(commitUrl, "POST", undefined, signal, z.unknown());
  }

  private async triggerBuild(participationId: number, signal: AbortSignal): Promise<void> {
    await this.call(
      this.endpoint(this.config.endpoints.trigger_build, { participationId }),
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

  /** Read the exercise's template and solution participations with their submissions and results. */
  private async readExerciseResults(
    exerciseId: number,
    signal: AbortSignal,
  ): Promise<z.infer<typeof exerciseResultsSchema>> {
    return this.call(
      this.endpoint(this.config.endpoints.exercise_results, { exerciseId }),
      "GET",
      undefined,
      signal,
      exerciseResultsSchema,
    );
  }

  /**
   * Every submission id currently attached to either participation, used to baseline a build.
   *
   * Submissions rather than results: a build of the seeded template can still be queued, or running,
   * when this is taken, so its *result* does not exist yet and a result-level baseline would let it
   * through. Its submission does exist, because Artemis creates the submission when it triggers the
   * build, so excluding the submission excludes the build whenever it happens to finish.
   */
  private async submissionIds(exerciseId: number, signal: AbortSignal): Promise<Set<number>> {
    const exercise = await this.readExerciseResults(exerciseId, signal);
    const ids = new Set<number>();
    for (const participation of [exercise.templateParticipation, exercise.solutionParticipation]) {
      for (const submission of participation?.submissions ?? []) {
        ids.add(submission.id);
      }
    }
    return ids;
  }

  /**
   * Wait until both participations have produced a result that did not exist at `baseline`.
   *
   * Artemis builds template and solution when it creates the exercise, so "the newest result" is not
   * enough: those seed builds ran against the seeded template, not the candidate's bundle. Only a
   * result whose id is new since the bundle was committed can have been built from it.
   *
   * The newest new result is also required to be *stable* across two consecutive polls. Committing
   * three repositories can enqueue more than one build, and without this the first result to land
   * -- possibly from the commit of the template repository, before the tests repository was
   * committed -- would be read as the answer.
   */
  private async awaitResults(
    exerciseId: number,
    baseline: Set<number>,
    signal: AbortSignal,
  ): Promise<{ template: CompletedBuild; solution: CompletedBuild }> {
    const deadline = this.now() + this.config.build_timeout_ms;
    let previous: string | undefined;
    for (;;) {
      const exercise = await this.readExerciseResults(exerciseId, signal);
      const template = newestSince(exercise.templateParticipation, baseline);
      const solution = newestSince(exercise.solutionParticipation, baseline);
      if (template !== undefined && solution !== undefined) {
        const observed = `${template.result.id}:${solution.result.id}`;
        if (observed === previous) {
          const templateParticipation = exercise.templateParticipation?.id;
          const solutionParticipation = exercise.solutionParticipation?.id;
          if (templateParticipation === undefined || solutionParticipation === undefined) {
            throw new InfrastructureError("Artemis reported results without a participation id");
          }
          return {
            template: await this.withFeedbacks(templateParticipation, template, signal),
            solution: await this.withFeedbacks(solutionParticipation, solution, signal),
          };
        }
        previous = observed;
      }
      if (this.now() >= deadline) {
        // A build that never finishes is infrastructure, not a failing exercise.
        throw new InfrastructureError(
          `LocalCI produced no new result for exercise ${exerciseId} within the build timeout`,
          "evaluator.timeout",
        );
      }
      await this.sleep(this.config.poll_interval_ms, signal);
    }
  }

  /**
   * Refuse to read a build the infrastructure stopped as a statement about the exercise.
   *
   * A build that LocalCI killed and a build whose code does not compile are the same object in the
   * results API: `buildFailed` on the submission, no feedbacks, no test cases. The difference is
   * only in the build log, so the log is read -- but only for a build that actually failed, so a
   * healthy evaluation pays nothing for this.
   */
  private async assertBuildRan(
    participationId: number,
    build: CompletedBuild,
    signal: AbortSignal,
  ): Promise<void> {
    if (build.submission.buildFailed !== true) {
      return;
    }
    const entries = await this.call(
      this.endpoint(this.config.endpoints.participation_build_logs, {
        participationId,
        resultId: build.result.id,
      }),
      "GET",
      undefined,
      signal,
      z.array(buildLogEntrySchema),
    );
    const log = entries.map((entry) => entry.log ?? "").join("\n");
    for (const failure of INFRASTRUCTURE_BUILD_FAILURES) {
      if (failure.pattern.test(log)) {
        throw new InfrastructureError(
          `${failure.describe} for participation ${participationId}`,
          failure.category,
        );
      }
    }
  }

  /**
   * Attach the per-test breakdown. The nested result carries only counts, so the test case names and
   * their outcomes -- everything the verdict is computed from -- come from this second call.
   */
  private async withFeedbacks(
    participationId: number,
    build: Omit<CompletedBuild, "feedbacks">,
    signal: AbortSignal,
  ): Promise<CompletedBuild> {
    const feedbacks = await this.call(
      this.endpoint(this.config.endpoints.result_details, {
        participationId,
        resultId: build.result.id,
      }),
      "GET",
      undefined,
      signal,
      z.array(feedbackSchema),
    );
    return { ...build, feedbacks };
  }
}

/** Every completed result on a participation, flattened out of its submissions, oldest id first. */
function completedBuilds(
  participation: z.infer<typeof participationWithSubmissionsSchema> | undefined,
): Array<Omit<CompletedBuild, "feedbacks">> {
  return (participation?.submissions ?? [])
    .flatMap((submission) =>
      (submission.results ?? [])
        .filter((result) => typeof result.completionDate === "string")
        .map((result) => ({ result, submission })),
    )
    .sort((left, right) => left.result.id - right.result.id);
}

/** The newest completed result whose *submission* was not already present in `baseline`. */
function newestSince(
  participation: z.infer<typeof participationWithSubmissionsSchema> | undefined,
  baseline: Set<number>,
): Omit<CompletedBuild, "feedbacks"> | undefined {
  return completedBuilds(participation)
    .filter((build) => !baseline.has(build.submission.id))
    .at(-1);
}

/**
 * The test case a feedback reports on, or null if it does not report on one.
 *
 * Artemis names an automatic feedback's test case in one of two places, and which one depends on
 * something outside this build. When the exercise's test cases are known, the feedback carries a
 * `testCase` relation holding the name. When they are not -- which is exactly what happens when the
 * *solution* build failed, because that is the build that establishes them -- the relation is absent
 * and the name is in `text` instead.
 *
 * Reading only the relation therefore loses every test case of a template build whose solution did
 * not compile: the feedbacks arrive, but they look like diagnostics and the suite reads as empty.
 *
 * The fallback additionally requires an explicit `positive`, because that is what makes a feedback
 * the *outcome* of a test rather than a remark about the build: every test-case feedback observed on
 * a live deployment states whether it passed, and a feedback that states nothing about passing is a
 * diagnostic no matter what its text says.
 */
function testCaseName(feedback: Feedback): string | null {
  if (feedback.testCase?.testName !== undefined) {
    return feedback.testCase.testName;
  }
  if (
    feedback.type === "AUTOMATIC" &&
    typeof feedback.positive === "boolean" &&
    typeof feedback.text === "string" &&
    feedback.text !== ""
  ) {
    return feedback.text;
  }
  return null;
}

/**
 * Map one completed Artemis build onto the backend-agnostic submission build contract.
 *
 * `buildFailed` lives on the submission rather than the result, and the feedbacks arrive from a
 * separate endpoint, so all three parts are passed in together.
 */
export function toSubmissionBuild(build: CompletedBuild): SubmissionBuild {
  const buildFailed = build.submission.buildFailed === true;
  const named = build.feedbacks.map((feedback) => ({
    feedback,
    name: testCaseName(feedback),
  }));
  const testCases: TestCaseResult[] = named
    .filter((entry) => entry.name !== null)
    .map(({ feedback, name }) => ({
      name: name as string,
      passed: feedback.positive === true,
      ...(feedback.detailText ? { message: feedback.detailText.slice(0, 500) } : {}),
    }));
  const diagnostics = named
    .filter((entry) => entry.name === null && entry.feedback.text)
    .map((entry) => String(entry.feedback.text).slice(0, 500))
    .slice(0, 32);
  return {
    compiled: !buildFailed,
    // A build that failed to compile ran no tests; a build that compiled and reported at least one
    // test case ran them. Anything else is unknown and reported as "not executed" rather than as a
    // pass rate over an empty suite.
    tests_executed: !buildFailed && testCases.length > 0,
    test_cases: testCases,
    // Artemis removed test-wise coverage support (ls1intum/Artemis#9993) and exposes no aggregate
    // coverage on a result either, so this backend can never report coverage. Both dimensions are
    // reported `not_applicable` rather than guessed; the container backend (WP2c) fills them.
    coverage: null,
    diagnostics,
  };
}
