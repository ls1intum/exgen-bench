import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleScores } from "../evaluators/java-oracle/evaluate.ts";
import {
  MavenBuildBackend,
  mavenBackendConfigSchema,
} from "../evaluators/java-oracle/maven-backend.ts";
import { loadWorkerConfig } from "../evaluators/java-oracle/worker.ts";
import type { CandidateBundle } from "../evaluators/shared/bundle.ts";
import type { EvaluationRequest } from "../src/evaluation/contracts.ts";

function bundle(files: Partial<CandidateBundle>): CandidateBundle {
  return {
    root: "/nowhere",
    statement: "",
    statementPath: "problem-statement.md",
    template: [],
    solution: [],
    tests: [],
    ...files,
  };
}

describe("the Maven build backend", () => {
  test("treats a build that produced no report and failed as a compile failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-compile-"));
    try {
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "false",
          work_directory: directory,
        }),
      );
      const outcome = await backend.build(
        {
          request: {} as EvaluationRequest,
          bundle: bundle({ tests: [{ path: "pom.xml", content: "<project/>", bytes: 11 }] }),
        },
        new AbortController().signal,
      );

      expect(outcome.solution.compiled).toBe(false);
      expect(outcome.solution.tests_executed).toBe(false);
      expect(outcome.solution.test_cases).toEqual([]);
      expect(outcome.template.compiled).toBe(false);
      expect(outcome.attestation.backend_id).toBe("maven");
      expect(outcome.attestation.unattested).toContain("build_agent_image");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses a candidate path that would escape the build tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-escape-"));
    try {
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "true",
          work_directory: directory,
        }),
      );
      // Generated content is written to disk, so a declared path that escapes would put model output
      // on the host. The bundle loader checks this too; the writer does not assume its caller did.
      await expect(
        backend.build(
          {
            request: {} as EvaluationRequest,
            bundle: bundle({
              tests: [{ path: "../escaped.java", content: "x", bytes: 1 }],
            }),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/escapes/);
      expect(await Bun.file(join(directory, "escaped.java")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("stops the build when the evaluation is cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-abort-"));
    try {
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "sleep",
          arguments: ["600"],
          work_directory: directory,
        }),
      );
      const controller = new AbortController();
      const build = backend.build(
        {
          request: {} as EvaluationRequest,
          bundle: bundle({ tests: [{ path: "pom.xml", content: "<project/>", bytes: 11 }] }),
        },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 50);

      const started = Date.now();
      await expect(build).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("gives up on a build that outlives its timeout and says so", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-timeout-"));
    try {
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "sleep",
          arguments: ["600"],
          build_timeout_ms: 200,
          work_directory: directory,
        }),
      );
      const outcome = await backend.build(
        {
          request: {} as EvaluationRequest,
          bundle: bundle({ tests: [{ path: "pom.xml", content: "<project/>", bytes: 11 }] }),
        },
        new AbortController().signal,
      );

      expect(outcome.solution.tests_executed).toBe(false);
      expect(outcome.solution.compiled).toBe(false);
      expect(outcome.solution.diagnostics.join(" ")).toContain("timeout");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a missing build command as an infrastructure failure, not a bad candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-nocmd-"));
    try {
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "exgen-no-such-maven",
          work_directory: directory,
        }),
      );
      await expect(
        backend.build(
          {
            request: {} as EvaluationRequest,
            bundle: bundle({ tests: [{ path: "pom.xml", content: "<project/>", bytes: 11 }] }),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/could not run/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("builds the template and the solution in trees that cannot see each other", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-isolation-"));
    try {
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "true",
          work_directory: directory,
          keep_build_trees: true,
        }),
      );
      await backend.build(
        {
          request: {} as EvaluationRequest,
          bundle: bundle({
            tests: [{ path: "pom.xml", content: "<project/>", bytes: 11 }],
            template: [{ path: "src/A.java", content: "// template", bytes: 11 }],
            solution: [{ path: "src/A.java", content: "// solution", bytes: 11 }],
          }),
        },
        new AbortController().signal,
      );

      const trees = (await readdir(directory)).filter((entry) => entry.startsWith("exgen-oracle-"));
      const root = join(directory, trees[0] ?? "");
      expect(await Bun.file(join(root, "template", "assignment", "src", "A.java")).text()).toBe(
        "// template",
      );
      expect(await Bun.file(join(root, "solution", "assignment", "src", "A.java")).text()).toBe(
        "// solution",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("puts the toolchain in the evidence a reader sees", () => {
    const build = {
      compiled: true,
      tests_executed: true,
      test_cases: [{ name: "a", passed: true }],
      coverage: null,
      diagnostics: [],
    };
    const scores = assembleScores(
      {
        template: { ...build, test_cases: [{ name: "a", passed: false }] },
        solution: build,
        attestation: {
          backend_id: "maven",
          artemis_revision: null,
          build_agent_image: null,
          build_script_revision: null,
          toolchain: "Apache Maven 3.8.7; Java version: 17.0.19",
          unattested: [],
        },
      },
      { satisfied: true, reasons: [] },
    );
    const evidence = scores.flatMap((entry) => entry.evidence ?? []);
    expect(evidence).toContain("toolchain:Apache Maven 3.8.7; Java version: 17.0.19");
  });

  test("is the backend the published java-oracle configuration selects", async () => {
    const { config: loaded } = await loadWorkerConfig(
      resolve(import.meta.dir, "../evaluators/java-oracle/config.maven.yaml"),
    );
    expect(loaded.backend.kind).toBe("maven");
  });

  test("refuses a configuration that names an unknown key", () => {
    expect(() => mavenBackendConfigSchema.parse({ kind: "maven", jdk: "17" })).toThrow();
  });
});

const integrationTest = process.env.EXGEN_MAVEN_INTEGRATION === "1" ? test : test.skip;

integrationTest(
  "builds a generated exercise and separates the solution from the template",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-live-"));
    try {
      const pom = await Bun.file(resolve(import.meta.dir, "fixtures/maven-oracle/pom.xml")).text();
      const testSource = await Bun.file(
        resolve(import.meta.dir, "fixtures/maven-oracle/AdderTest.java"),
      ).text();
      await writeFile(join(directory, "unused"), "");
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({ kind: "maven", work_directory: directory }),
      );
      const outcome = await backend.build(
        {
          request: {} as EvaluationRequest,
          bundle: bundle({
            tests: [
              { path: "pom.xml", content: pom, bytes: pom.length },
              { path: "test/AdderTest.java", content: testSource, bytes: testSource.length },
            ],
            solution: [
              {
                path: "src/Adder.java",
                content:
                  "public class Adder { public static int add(int a, int b) { return a + b; } }",
                bytes: 0,
              },
            ],
            template: [
              {
                path: "src/Adder.java",
                content: "public class Adder { public static int add(int a, int b) { return 0; } }",
                bytes: 0,
              },
            ],
          }),
        },
        new AbortController().signal,
      );

      expect(outcome.solution.compiled).toBe(true);
      expect(outcome.solution.tests_executed).toBe(true);
      expect(outcome.solution.test_cases.every((testCase) => testCase.passed)).toBe(true);
      expect(outcome.template.compiled).toBe(true);
      expect(outcome.template.test_cases.some((testCase) => testCase.passed)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  600_000,
);
