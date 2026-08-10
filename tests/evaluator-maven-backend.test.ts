import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MavenBuildBackend,
  mavenBackendConfigSchema,
} from "../evaluators/java-oracle/maven-backend.ts";
import { loadWorkerConfig } from "../evaluators/java-oracle/worker.ts";
import type { CandidateBundle } from "../evaluators/shared/bundle.ts";
import type { EvaluationRequest } from "../src/evaluation/contracts.ts";

/**
 * These cover the parts of the backend that decide a verdict from a build: how a surefire report is
 * read, and how a failed compile is told apart from a failed test. Building a real exercise needs a
 * Maven and a JDK, so it is exercised by `EXGEN_MAVEN_INTEGRATION=1` rather than by default.
 */
const config = mavenBackendConfigSchema.parse({ kind: "maven" });

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
<testsuite name="ExampleTest" tests="5" failures="1" errors="1" skipped="1">
  <testcase name="passes" classname="ExampleTest" time="0.01"/>
  <testcase name="alsoPasses" classname="ExampleTest" time="0.02"></testcase>
  <testcase name="failsWithMessage" classname="ExampleTest" time="0.03">
    <failure message="expected 6 but was &lt;0&gt;" type="AssertionError">stack</failure>
  </testcase>
  <testcase name="errors" classname="ExampleTest" time="0.04">
    <error message="boom &amp; more" type="IllegalStateException">stack</error>
  </testcase>
  <testcase name="isSkipped" classname="ExampleTest" time="0">
    <skipped/>
  </testcase>
</testsuite>`;

describe("the Maven build backend", () => {
  test("reads a surefire report, decodes messages, and drops skipped cases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-parse-"));
    try {
      const reports = join(directory, "template", "target", "surefire-reports");
      await Bun.write(join(reports, "TEST-ExampleTest.xml"), REPORT);
      // Nothing to build: the tests and the submission are empty, so Maven fails immediately and the
      // reports written above are what the backend reads.
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "true",
          work_directory: directory,
        }),
      );
      const cases = await backend["readReports"](join(directory, "template"));

      expect(cases?.map((testCase) => testCase.name)).toEqual([
        "passes",
        "alsoPasses",
        "failsWithMessage",
        "errors",
      ]);
      expect(cases?.map((testCase) => testCase.passed)).toEqual([true, true, false, false]);
      // A skipped case never ran, so counting it would move both pass rates the gate compares.
      expect(cases?.some((testCase) => testCase.name === "isSkipped")).toBe(false);
      expect(cases?.[2]?.message).toBe("expected 6 but was <0>");
      expect(cases?.[3]?.message).toBe("boom & more");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a suite that never started as not executed rather than as an empty suite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-missing-"));
    try {
      const backend = new MavenBuildBackend(config);
      // No surefire directory at all: the sources did not compile, or the suite never started.
      expect(await backend["readReports"](directory)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("treats a build that produced no report and failed as a compile failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-compile-"));
    try {
      // `false` stands in for a Maven that exits non-zero without writing a report.
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
      // Nothing about this build was attested by a deployment, and the outcome says so.
      expect(outcome.attestation.unattested).toContain("build_agent_image");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
