import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadWorkerConfig, workerConfigDigest } from "../evaluators/java-oracle/worker.ts";

/**
 * WP2a declares that an evaluator starting durable remote work must configure `process.recovery`
 * (`docs/PROCESS-EVALUATORS.md`), and `LocalCiBuildBackend.recover` reconciles the orphaned exercise
 * a killed build leaves behind (issue #26). This is the CLI-level proof: a real Artemis-shaped mock
 * server, a real `worker.ts` subprocess killed mid-build, and a real `worker.ts --recover` subprocess
 * addressing the same exercise by the evaluation ID both share.
 *
 * The mock never answers `trigger-build`, so the build subprocess is genuinely mid-build -- past
 * exercise creation, past pushing the bundle, blocked on the call whose response starts the build --
 * when it is killed. `LocalCiBuildBackend.build`'s own `finally` cleanup never runs on a kill, which
 * is exactly the gap recovery exists to close.
 */

const WORKER = resolve(import.meta.dir, "../evaluators/java-oracle/worker.ts");
const FIXTURES = resolve(import.meta.dir, "../evaluators/fixtures");
const USERNAME_ENV = "EXGEN_TEST_ARTEMIS_USERNAME";
const PASSWORD_ENV = "EXGEN_TEST_ARTEMIS_PASSWORD";

interface MockExercise {
  id: number;
  shortName: string;
  projectKey: string;
  testRepositoryUri: null;
  buildConfig: null;
  templateParticipation: { id: number };
  solutionParticipation: { id: number };
}

function startMockArtemis() {
  const exercises: MockExercise[] = [];
  const deletedIds: number[] = [];
  let nextId = 1;
  let resolveTriggerReached: () => void;
  const triggerReached = new Promise<void>((resolvePromise) => {
    resolveTriggerReached = resolvePromise;
  });

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const { method } = request;

      if (method === "POST" && pathname === "/api/core/public/authenticate") {
        return new Response("{}", {
          status: 200,
          headers: { "Set-Cookie": "jwt=test-session; Path=/" },
        });
      }
      if (method === "GET" && pathname === "/api/programming/courses/7/programming-exercises") {
        return Response.json(exercises);
      }
      if (method === "POST" && pathname === "/api/programming/programming-exercises/setup") {
        const body = (await request.json().catch(() => ({}))) as { shortName?: string };
        const created: MockExercise = {
          id: nextId++,
          shortName: body.shortName ?? `unnamed-${nextId}`,
          projectKey: "TEST",
          testRepositoryUri: null,
          buildConfig: null,
          templateParticipation: { id: 101 },
          solutionParticipation: { id: 102 },
        };
        exercises.push(created);
        return Response.json(created);
      }
      const exerciseById = pathname.match(/^\/api\/programming\/programming-exercises\/(\d+)$/);
      if (exerciseById) {
        const id = Number(exerciseById[1]);
        if (method === "GET") {
          const found = exercises.find((exercise) => exercise.id === id);
          return found ? Response.json(found) : new Response("not found", { status: 404 });
        }
        if (method === "DELETE") {
          const index = exercises.findIndex((exercise) => exercise.id === id);
          if (index >= 0) {
            exercises.splice(index, 1);
            deletedIds.push(id);
          }
          return Response.json({});
        }
      }
      const results = pathname.match(
        /^\/api\/programming\/programming-exercises\/(\d+)\/with-template-and-solution-participation$/,
      );
      if (method === "GET" && results) {
        return Response.json({
          id: Number(results[1]),
          templateParticipation: { id: 101, submissions: [] },
          solutionParticipation: { id: 102, submissions: [] },
        });
      }
      if (method === "GET" && /^\/api\/programming\/repository\/\d+\/files$/.test(pathname)) {
        return Response.json({});
      }
      if (method === "POST" && /^\/api\/programming\/repository\/\d+\/file$/.test(pathname)) {
        return Response.json({});
      }
      if (method === "POST" && /^\/api\/programming\/repository\/\d+\/commit$/.test(pathname)) {
        return Response.json({});
      }
      if (method === "GET" && /^\/api\/programming\/test-repository\/\d+\/files$/.test(pathname)) {
        return Response.json({});
      }
      if (method === "POST" && /^\/api\/programming\/test-repository\/\d+\/file$/.test(pathname)) {
        return Response.json({});
      }
      if (
        method === "POST" &&
        /^\/api\/programming\/test-repository\/\d+\/commit$/.test(pathname)
      ) {
        return Response.json({});
      }
      if (
        method === "POST" &&
        /^\/api\/programming\/participations\/\d+\/trigger-build$/.test(pathname)
      ) {
        // Never answers: the build subprocess blocks here, which is what makes the kill below a
        // genuine mid-build kill rather than a kill after the exercise was already cleaned up.
        resolveTriggerReached();
        return new Promise<Response>(() => {});
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    triggerReached,
    exercises,
    deletedIds,
    stop: () => server.stop(true),
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("java-oracle LocalCI recovery, end to end through the CLI", () => {
  test(
    "a build killed mid-flight leaves an orphaned exercise that --recover deletes",
    async () => {
      const mock = startMockArtemis();
      try {
        const directory = await mkdtemp(join(tmpdir(), "exgen-oracle-recovery-"));
        temporaryDirectories.push(directory);
        const configPath = join(directory, "config.json");
        await writeFile(
          configPath,
          JSON.stringify({
            schema_version: "1",
            username_env: USERNAME_ENV,
            password_env: PASSWORD_ENV,
            backend: {
              kind: "localci",
              base_url: mock.baseUrl,
              evaluation_course_id: 7,
              generation_course_ids: [],
              poll_interval_ms: 250,
              build_timeout_ms: 60_000,
              request_timeout_ms: 30_000,
              delete_exercise_after_build: true,
            },
          }),
        );
        const { config } = await loadWorkerConfig(configPath);
        const digest = workerConfigDigest(config);
        const env = {
          ...process.env,
          [USERNAME_ENV]: "evaluation-account",
          [PASSWORD_ENV]: "evaluation-secret",
        };
        const request = {
          protocol_version: "1",
          evaluation_id: "a".repeat(64),
          candidate: {
            experiment_id: "x",
            attempt_id: "a",
            generation_key: "a".repeat(64),
            case_id: "correct-exercise",
            system_id: "s",
            replicate: 1,
            artifact_digest: "b".repeat(64),
            bundle_path: resolve(FIXTURES, "correct-exercise/bundle"),
          },
          evaluator: {
            id: "java-oracle",
            version: "1",
            revision: "r",
            target_profile: "artemis-java-maven",
            implementation_digest: "c".repeat(64),
          },
          suite: { id: "s", version: "1", digest: "d".repeat(64) },
          requested_metrics: [],
        };
        const requestJson = JSON.stringify(request);

        const build = Bun.spawn(
          [process.execPath, "run", WORKER, "--config", configPath, "--config-digest", digest],
          { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        );
        build.stdin.write(requestJson);
        build.stdin.end();

        await Promise.race([
          mock.triggerReached,
          build.exited.then(() => {
            throw new Error("build exited before reaching trigger-build; recovery has nothing to prove");
          }),
        ]);
        expect(mock.exercises).toHaveLength(1);
        const orphaned = mock.exercises[0];
        if (orphaned === undefined) {
          throw new Error("expected the mock server to have created an exercise");
        }

        // The kill is ungraceful on purpose: `LocalCiBuildBackend.build`'s own `finally` cleanup
        // never runs, so the exercise it created stays behind exactly as a real process kill would
        // leave it.
        build.kill("SIGKILL");
        await build.exited;
        expect(mock.exercises).toHaveLength(1);
        expect(mock.deletedIds).toHaveLength(0);

        const recover = Bun.spawn(
          [
            process.execPath,
            "run",
            WORKER,
            "--config",
            configPath,
            "--config-digest",
            digest,
            "--recover",
          ],
          { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        );
        recover.stdin.write(requestJson);
        recover.stdin.end();
        const [code, stderr] = await Promise.all([
          recover.exited,
          new Response(recover.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(mock.deletedIds).toEqual([orphaned.id]);
        expect(mock.exercises).toHaveLength(0);
        void stderr;
      } finally {
        mock.stop();
      }
    },
    10_000,
  );
});
