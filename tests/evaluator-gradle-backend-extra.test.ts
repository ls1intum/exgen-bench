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
previous=""
for argument in "$@"; do
  if [ "$previous" = "--init-script" ]; then
    case "$argument" in /*) echo "absolute init script: $argument"; exit 3;; esac
    [ -f "$argument" ] || { echo "missing init script: $argument"; exit 3; }
  fi
  previous="$argument"
done
variant=$(basename "$PWD")
scenario="__SCENARIO__"
pass() { echo "<testcase name=\\"$1\\" classname=\\"p.ClientTest\\"/>"; }
fail() { echo "<testcase name=\\"$1\\" classname=\\"p.ClientTest\\"><failure message=\\"x\\"/></testcase>"; }
report() { mkdir -p build/test-results/test; echo "<testsuite>$1</testsuite>" > build/test-results/test/TEST-p.ClientTest.xml; }
pit() { mkdir -p build/reports/pitest; echo "<mutations><mutation detected='true' status='KILLED'><mutatedClass>p.Client</mutatedClass><mutatedMethod>main</mutatedMethod><lineNumber>3</lineNumber><mutator>x.VoidMethodCallMutator</mutator></mutation></mutations>" > build/reports/pitest/mutations.xml; }
main() { mkdir -p build/exgen-main; printf 'Hi\\n' > build/exgen-main/stdout.txt; [ -n "$1" ] && echo "$1" > build/exgen-main/exit.txt; }
case "$variant" in
  template) report "$(fail printsLine)$(fail printsCount)";;
  solution)
    case "$scenario" in
      zero-tests) report "";;
      *) report "$(pass printsLine)$(pass printsCount)";;
    esac;;
  mutation)
    task=pitest
    case " $* " in *" exgenRunMain "*) task=main;; esac
    case "$scenario:$task" in
      no-report:*) echo "FAILURE: Build failed with an exception."; exit 1;;
      timeout:*) exec sleep 5;;
      pit-timeout-after-report:pitest) pit; exec sleep 5;;
      pit-fails-after-report:*) pit; main 0; echo "FAILURE: Build failed with an exception."; exit 1;;
      main-timeout:main) main; exit 1;;
      main-exit-3:main) main 3;;
      main-overcap:main) mkdir -p build/exgen-main; head -c 70000 /dev/zero | tr '\\0' 'x' > build/exgen-main/stdout.txt; echo 0 > build/exgen-main/exit.txt;;
      main-not-utf8:main) mkdir -p build/exgen-main; printf '\\377\\376' > build/exgen-main/stdout.txt; echo 0 > build/exgen-main/exit.txt;;
      *:pitest) pit;;
      *:main) main 0;;
    esac;;
  bypass-scope)
    case "$scenario" in
      scope-no-tests) echo "FAILURE: Build failed with an exception."; exit 1;;
      scope-partial) report "$(fail printsLine)";;
      scope-ungraded) report "$(pass printsLine)$(pass printsCount)";;
      *) report "$(fail printsLine)$(fail printsCount)";;
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
  options: {
    extra_timeout_ms?: number;
    timeout_ms?: number;
    analysis?: boolean;
    bundle?: CandidateBundle;
    mutation?: boolean;
  } = {},
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
      analysis: options.analysis ?? false,
      mutation: options.mutation ?? true,
      work_directory: join(directory, "work"),
      ...(options.extra_timeout_ms === undefined
        ? {}
        : { extra_timeout_ms: options.extra_timeout_ms }),
    }),
  );
  const request = (
    options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }
  ) as EvaluationRequest;
  const outcome = await backend.build(
    { request, bundle: options.bundle ?? BUNDLE },
    new AbortController().signal,
  );
  return { outcome, directory };
}

describe("the Gradle backend's extra passes", () => {
  test("are off unless the configuration turns them on", async () => {
    expect(gradleBackendConfigSchema.parse({ kind: "gradle" }).mutation).toBe(false);
    const { outcome } = await run("ok", { mutation: false });
    expect(outcome.solution.tests_executed).toBe(true);
    expect(outcome.mutation).toMatchObject({ status: "not_applicable" });
    expect(outcome.mutation?.reason).toContain("mutation: false");
    expect(outcome.bypass?.status).toBe("not_applicable");
    expect(mutationScores(outcome)[0]?.message).toContain("isolates every build");
  });

  test("measure PIT and the bypass when every build leaves its reports", async () => {
    const { outcome } = await run("ok");
    expect(outcome.mutation?.status).toBe("measured");
    expect(outcome.bypass).toMatchObject({ status: "measured", main_class: "p.Client" });
    expect(bypassScore(outcome, assignLanes(outcome, CATALOG))).toMatchObject({ value: true });
  });

  test("measures a reflective entry point and rejects incomplete or unobserved grading scope", async () => {
    const bundle = {
      ...BUNDLE,
      tests: [
        BUNDLE.tests[0]!,
        file(
          "test/p/ClientTest.java",
          'package p; class ClientTest { void t() throws Exception { Class.forName("p.Client").getMethod("main", String[].class).invoke(null, (Object)new String[0]); } }',
        ),
      ],
    };
    const { outcome } = await run("ok", { bundle });
    expect(bypassScore(outcome, assignLanes(outcome, CATALOG))).toMatchObject({
      value: true,
      metric_version: "3",
    });
    for (const [scenario, status] of [
      ["scope-no-tests", "infra_failure"],
      ["scope-partial", "infra_failure"],
      ["scope-ungraded", "not_applicable"],
    ] as const) {
      const result = await run(scenario);
      expect(bypassScore(result.outcome, assignLanes(result.outcome, CATALOG)).status).toBe(status);
      expect(result.outcome.solution.test_cases.every((testCase) => testCase.passed)).toBe(true);
    }
  });

  test("names init scripts relative to the build tree, so a container wrapper can run it", async () => {
    const { outcome } = await run("ok", { analysis: true });
    expect(outcome.solution.tests_executed).toBe(true);
    expect(outcome.mutation?.status).toBe("measured");
    expect(outcome.bypass?.status).toBe("measured");
  });

  test("a file name that is no class name never costs the oracle verdict", async () => {
    const odd = {
      ...BUNDLE,
      template: [],
      solution: [
        file(
          "src/p/W(.java",
          "package p;\npublic class W {\n  public static void main(String[] args) {}\n}\n",
        ),
      ],
      tests: [
        BUNDLE.tests[0]!,
        file(
          "test/p/ClientTest.java",
          "package p;\nclass ClientTest { void t() { W.main(null); } }\n",
        ),
      ],
    };
    const { outcome } = await run("ok", { bundle: odd });
    expect(outcome.solution.tests_executed).toBe(true);
    expect(outcome.mutation?.status).not.toBeUndefined();
    expect(outcome.bypass?.main_class).toBe("p.W");
  });

  test("a report left by a PIT run that timed out or failed is never trusted", async () => {
    for (const scenario of ["pit-timeout-after-report", "pit-fails-after-report"]) {
      const { outcome } = await run(scenario, { extra_timeout_ms: 1_000 });
      expect(outcome.mutation?.status).toBe("failed");
      expect(mutationScores(outcome)[0]?.status).toBe("infra_failure");
    }
  });

  test("a PIT report shipped in the candidate's tests is ignored", async () => {
    const shipped = {
      ...BUNDLE,
      tests: [
        ...BUNDLE.tests,
        file(
          "build/reports/pitest/mutations.xml",
          "<mutations><mutation status='KILLED'><mutatedClass>p.Client</mutatedClass><mutatedMethod>m</mutatedMethod><lineNumber>1</lineNumber><mutator>M</mutator></mutation></mutations>",
        ),
      ],
    };
    const { outcome } = await run("no-report", { bundle: shipped });
    expect(outcome.mutation?.status).toBe("failed");
  });

  test("a main that exits non-zero, prints too much or prints no UTF-8 is not applicable", async () => {
    const reasons: Record<string, string> = {
      "main-exit-3": "exited with status 3",
      "main-overcap": "printed more than",
      "main-not-utf8": "not UTF-8",
    };
    for (const [scenario, reason] of Object.entries(reasons)) {
      const { outcome } = await run(scenario);
      expect(outcome.mutation?.status).toBe("measured");
      expect(outcome.bypass).toMatchObject({ status: "not_applicable" });
      expect(outcome.bypass?.reason).toContain(reason);
    }
  });

  test("a solution run without tests starts no extra pass", async () => {
    const { outcome } = await run("zero-tests");
    expect(outcome.solution.tests_executed).toBe(true);
    expect(outcome.solution.test_cases).toEqual([]);
    expect(outcome.mutation).toBeUndefined();
    expect(outcome.bypass).toBeUndefined();
    expect(mutationScores(outcome)[0]?.message).toContain("passes every test");
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
