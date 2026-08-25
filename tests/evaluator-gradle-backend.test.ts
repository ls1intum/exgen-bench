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

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ExampleTest" tests="3" failures="1" errors="0" skipped="1">
  <testcase name="passes" classname="ExampleTest"/>
  <testcase name="fails" classname="ExampleTest"><failure message="expected &lt;1&gt;">stack</failure></testcase>
  <testcase name="skipped" classname="ExampleTest"><skipped/></testcase>
</testsuite>`;

describe("the Gradle build backend", () => {
  test("reads Gradle JUnit XML and excludes skipped tests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-gradle-report-"));
    try {
      const reports = join(directory, "build", "test-results", "test");
      await Bun.write(join(reports, "TEST-ExampleTest.xml"), REPORT);
      const backend = new GradleBuildBackend(gradleBackendConfigSchema.parse({ kind: "gradle" }));
      const cases = await backend["readReports"](directory);

      expect(cases).toEqual([
        { name: "passes", passed: true },
        { name: "fails", passed: false, message: "expected <1>" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
