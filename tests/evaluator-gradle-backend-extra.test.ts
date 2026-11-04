import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvaluationRequest } from "../src/evaluation/contracts.ts";
import type { CandidateBundle } from "../tools/kit/bundle.ts";
import type { CatalogTest } from "../tools/kit/test-catalog.ts";
import {
  assignLanes,
  bypassScore,
  mutationScores,
} from "../tools/tier1-deterministic/java-oracle/evaluate.ts";
import {
  gradleBackendConfigSchema,
  GradleBuildBackend,
} from "../tools/tier1-deterministic/java-oracle/gradle-backend.ts";

/**
 * A stand-in for Gradle: it writes the reports a real build would leave, chosen by the build tree it
 * runs in (template, solution, mutation, bypass) and by the scenario baked into it.
 */
const FAKE_GRADLE = `#!/usr/bin/env bash
case " $* " in *" --version "*) echo "Gradle 9.8.0"; exit 0;; esac
variant=$(basename "$PWD")
scenario="__SCENARIO__"
pass() { echo "<testcase name=\\"$1\\" classname=\\"p.ClientTest\\"/>"; }
fail() { echo "<testcase name=\\"$1\\" classname=\\"p.ClientTest\\"><failure message=\\"x\\"/></testcase>"; }
report() { mkdir -p build/test-results/test; echo "<testsuite>$1</testsuite>" > build/test-results/test/TEST-p.ClientTest.xml; }
pit() { mkdir -p build/reports/pitest; echo "<mutations><mutation detected='true' status='KILLED'><mutatedClass>p.Client</mutatedClass><mutatedMethod>main</mutatedMethod><lineNumber>3</lineNumber><mutator>x.VoidMethodCallMutator</mutator></mutation></mutations>" > build/reports/pitest/mutations.xml; }
main() { mkdir -p build/exgen-main; printf 'Hi\\n' > build/exgen-main/stdout.txt; [ -n "$1" ] && echo "$1" > build/exgen-main/exit.txt; }
case "$variant" in
  template) report "$(fail printsLine)$(fail printsCount)";;
  solution) report "$(pass printsLine)$(pass printsCount)";;
  mutation)
    case "$scenario" in
      no-report) echo "FAILURE: Build failed with an exception."; exit 1;;
      timeout) exec sleep 5;;
      main-timeout) pit; main; exit 1;;
      *) pit; main 0;;
    esac;;
  bypass)
    case "$scenario" in
      bypass-no-tests) echo "FAILURE: Build failed with an exception."; exit 1;;
      bypass-partial) report "$(pass printsLine)";;
      *) report "$(pass printsLine)$(pass printsCount)";;
    esac;;
esac
`;

const file = (path: string, content: string) => ({ path, content, bytes: content.length });

const BUNDLE: CandidateBundle = {
  root: "/nowhere",
  statement: "",
  statementPath: "problem-statement.md",
  tests: [
    file("build.gradle", "plugins { id 'java' }\n"),
    file(
      "test/p/ClientTest.java",
      "package p;\nclass ClientTest { void t() { Client.main(new String[0]); } }\n",
    ),
  ],
  template: [
    file(
      "src/p/Client.java",
      "package p;\npublic class Client {\n  public static void main(String[] args) {}\n}\n",
    ),
  ],
  solution: [
    file(
      "src/p/Client.java",
      'package p;\npublic class Client {\n  public static void main(String[] args) { System.out.println("Hi"); }\n}\n',
    ),
  ],
};

const CATALOG: CatalogTest[] = ["printsLine", "printsCount"].map((name, id) => ({
  id,
  name,
  type: "BEHAVIORAL",
  weight: 1,
  bonusPoints: 0,
  visibility: "ALWAYS",
  active: true,
}));

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function run(
  scenario: string,
  options: { extra_timeout_ms?: number; timeout_ms?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "exgen-gradle-extra-"));
  directories.push(directory);
  const command = join(directory, "fake-gradle");
  await writeFile(command, FAKE_GRADLE.replace("__SCENARIO__", scenario));
  await chmod(command, 0o755);
  const backend = new GradleBuildBackend(
    gradleBackendConfigSchema.parse({
      kind: "gradle",
      command,
      analysis: false,
      work_directory: join(directory, "work"),
      ...(options.extra_timeout_ms === undefined
        ? {}
        : { extra_timeout_ms: options.extra_timeout_ms }),
    }),
  );
  const request = (
    options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }
  ) as EvaluationRequest;
  const outcome = await backend.build({ request, bundle: BUNDLE }, new AbortController().signal);
  return { outcome, directory };
}

describe("the Gradle backend's extra passes", () => {
  test("measure PIT and the bypass when every build leaves its reports", async () => {
    const { outcome } = await run("ok");
    expect(outcome.mutation?.status).toBe("measured");
    expect(outcome.bypass).toMatchObject({ status: "measured", main_class: "p.Client" });
    expect(bypassScore(outcome, assignLanes(outcome, CATALOG))).toMatchObject({ value: true });
  });

  test("an Ares-free build that fails before main is a failure, never a property of the candidate", async () => {
    const { outcome } = await run("no-report");
    expect(outcome.mutation?.status).toBe("failed");
    expect(outcome.bypass?.status).toBe("failed");
    expect(outcome.bypass?.reason).toContain("never ran the solution's main");
    expect(mutationScores(outcome)[0]?.status).toBe("infra_failure");
    expect(bypassScore(outcome, assignLanes(outcome, CATALOG)).status).toBe("infra_failure");
  });

  test("an Ares-free build that runs out of time is a failure of both passes", async () => {
    const { outcome } = await run("timeout", { extra_timeout_ms: 1_000 });
    expect(outcome.mutation?.status).toBe("failed");
    expect(outcome.bypass).toMatchObject({ status: "failed" });
    expect(outcome.bypass?.reason).toContain("exceeded its time limit");
  });

  test("a main that started and never finished is not applicable", async () => {
    const { outcome } = await run("main-timeout");
    expect(outcome.mutation?.status).toBe("measured");
    expect(outcome.bypass).toMatchObject({ status: "not_applicable" });
    expect(outcome.bypass?.reason).toContain("did not finish within 20 s");
  });

  test("a bypass build that runs no tests is a failure", async () => {
    const { outcome } = await run("bypass-no-tests");
    expect(outcome.bypass?.status).toBe("failed");
    expect(outcome.bypass?.reason).toContain("ran no tests");
    expect(bypassScore(outcome, assignLanes(outcome, CATALOG)).status).toBe("infra_failure");
  });

  test("a bypass build that reports only some gradable tests yields no verdict", async () => {
    const { outcome } = await run("bypass-partial");
    expect(outcome.bypass?.status).toBe("measured");
    expect(bypassScore(outcome, assignLanes(outcome, CATALOG)).status).toBe("infra_failure");
  });

  test("extra passes are not started when the evaluation's time budget is nearly spent", async () => {
    const { outcome, directory } = await run("ok", { timeout_ms: 90_000 });
    expect(outcome.solution.tests_executed).toBe(true);
    expect(outcome.mutation?.status).toBe("failed");
    expect(outcome.mutation?.reason).toContain("time budget");
    expect(outcome.bypass?.status).toBe("failed");
    const [root] = await readdir(join(directory, "work"));
    expect(root).toBeUndefined();
  });
});
