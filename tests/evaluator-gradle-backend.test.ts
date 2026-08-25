import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CandidateBundle } from "../evaluators/shared/bundle.ts";
import {
  GradleBuildBackend,
  gradleBackendConfigSchema,
} from "../evaluators/java-oracle/gradle-backend.ts";
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

describe("the Gradle build backend", () => {
  test("distinguishes a build that never started its tests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-gradle-compile-"));
    try {
      const backend = new GradleBuildBackend(
        gradleBackendConfigSchema.parse({
          kind: "gradle",
          command: "false",
          work_directory: directory,
        }),
      );
      const outcome = await backend.build(
        {
          request: {} as EvaluationRequest,
          bundle: bundle({ tests: [{ path: "build.gradle", content: "plugins {}", bytes: 10 }] }),
        },
        new AbortController().signal,
      );

      expect(outcome.template.compiled).toBe(false);
      expect(outcome.template.tests_executed).toBe(false);
      expect(outcome.solution.compiled).toBe(false);
      expect(outcome.attestation.backend_id).toBe("gradle");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses candidate paths that escape the build tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-gradle-escape-"));
    try {
      const backend = new GradleBuildBackend(
        gradleBackendConfigSchema.parse({
          kind: "gradle",
          command: "true",
          work_directory: directory,
        }),
      );
      await expect(
        backend.build(
          {
            request: {} as EvaluationRequest,
            bundle: bundle({ tests: [{ path: "../escaped", content: "x", bytes: 1 }] }),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("escapes");
      expect(await Bun.file(join(directory, "escaped")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a missing Gradle installation as infrastructure failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-gradle-command-"));
    try {
      const backend = new GradleBuildBackend(
        gradleBackendConfigSchema.parse({
          kind: "gradle",
          command: "exgen-no-such-gradle",
          work_directory: directory,
        }),
      );
      await expect(
        backend.build(
          {
            request: {} as EvaluationRequest,
            bundle: bundle({ tests: [{ path: "build.gradle", content: "plugins {}", bytes: 10 }] }),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("could not run");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const integrationTest = process.env.EXGEN_GRADLE_INTEGRATION === "1" ? test : test.skip;

integrationTest(
  "builds an Artemis-style Gradle exercise and separates solution from template",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-gradle-live-"));
    try {
      const build = `plugins { id 'java' }
repositories { mavenCentral() }
dependencies { testImplementation 'org.junit.jupiter:junit-jupiter:5.11.4' }
test { useJUnitPlatform() }
sourceSets {
  main { java.srcDirs = ['assignment/src'] }
  test { java.srcDirs = ['test'] }
}
`;
      const testSource = `import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;
class AdderTest { @Test void adds() { assertEquals(5, Adder.add(2, 3)); } }
`;
      const backend = new GradleBuildBackend(
        gradleBackendConfigSchema.parse({
          kind: "gradle",
          work_directory: directory,
          user_home: join(directory, "gradle-home"),
        }),
      );
      const outcome = await backend.build(
        {
          request: {} as EvaluationRequest,
          bundle: bundle({
            tests: [
              { path: "build.gradle", content: build, bytes: build.length },
              { path: "test/AdderTest.java", content: testSource, bytes: testSource.length },
            ],
            solution: [
              {
                path: "src/Adder.java",
                content:
                  "public class Adder { static int add(int left, int right) { return left + right; } }",
                bytes: 0,
              },
            ],
            template: [
              {
                path: "src/Adder.java",
                content: "public class Adder { static int add(int left, int right) { return 0; } }",
                bytes: 0,
              },
            ],
          }),
        },
        new AbortController().signal,
      );

      expect(outcome.solution.test_cases).toEqual([{ name: "adds()", passed: true }]);
      expect(outcome.template.test_cases).toHaveLength(1);
      expect(outcome.template.test_cases[0]).toMatchObject({ name: "adds()", passed: false });
      expect(outcome.attestation.toolchain).toContain("Gradle ");
      expect(outcome.attestation.toolchain).toContain("JVM:");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  600_000,
);
