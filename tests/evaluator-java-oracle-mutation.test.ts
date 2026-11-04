import { describe, expect, test } from "bun:test";

import type { BuildOutcome, Mutant } from "../tools/tier1-deterministic/java-oracle/backend.ts";
import { mutationScores } from "../tools/tier1-deterministic/java-oracle/evaluate.ts";
import {
  aresFreeBuildScript,
  parsePitReport,
  pitInitScript,
  summariseMutants,
  testClassNames,
} from "../tools/tier1-deterministic/java-oracle/mutation.ts";

const ARES_BUILD = `plugins {
    id 'com.teamscale' version '39.0.0'
    id 'java'
    id 'io.freefair.aspectj.post-compile-weaving' version '9.8.0'
}
dependencies {
    testImplementation "de.tum.cit.ase:ares:\${aresVersion}"
    aspect "de.tum.cit.ase:ares:\${aresVersion}"
    implementation "org.aspectj:aspectjrt:\${aspectjVersion}"
}
def aresJvmArguments = objects.newInstance(AresJvmArguments)
tasks.withType(Test).configureEach {
    jvmArgumentProviders.add(aresJvmArguments)
}
test { useJUnitPlatform() }
`;

const file = (path: string, content: string) => ({ path, content, bytes: content.length });

describe("the Ares-free build for PIT", () => {
  test("removes exactly the agent arguments, the weaving plugin and the aspect dependency", () => {
    const result = aresFreeBuildScript(ARES_BUILD, []);
    if (!result.ok) throw new Error(result.reason);
    expect(result.removed).toHaveLength(3);
    expect(result.script).not.toContain("post-compile-weaving");
    expect(result.script).not.toContain('aspect "de.tum.cit.ase');
    expect(result.script).toContain('compileOnly "de.tum.cit.ase:ares:${aresVersion}"');
    expect(result.script).not.toContain("jvmArgumentProviders.add");
    expect(result.script).toContain('testImplementation "de.tum.cit.ase:ares');
    expect(result.script).toContain("id 'com.teamscale'");
    expect(result.script).toContain("aspectjrt");
  });

  test("leaves a build without Ares unchanged", () => {
    const plain = "plugins { id 'java' }\n";
    expect(aresFreeBuildScript(plain, [])).toEqual({ ok: true, script: plain, removed: [] });
  });

  test("refuses Ares 1, whose security manager PIT cannot run under", () => {
    const result = aresFreeBuildScript("plugins { id 'java' }", [
      file("test/T.java", "import de.tum.in.test.api.jupiter.Public;\nclass T {}"),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Ares 1");
  });

  test("refuses a build whose Ares hooks it does not recognise", () => {
    const result = aresFreeBuildScript(
      "test { jvmArgumentProviders.add(aresJvmArguments); useJUnitPlatform() }",
      [],
    );
    expect(result.ok).toBe(false);
  });
});

describe("remnants of Ares after the patch", () => {
  const reserved = file(
    "gradle/AresReservedPackages.gradle",
    "def patterns = ['org/aspectj/**', 'de/tum/cit/ase/ares/**']\n",
  );
  const PROVIDER = `abstract class AresJvmArguments implements CommandLineArgumentProvider {
    @Override
    Iterable<String> asArguments() { ["-javaagent:\${agentJar.singleFile.absolutePath}".toString()] }
}
aresJvmArguments.agentJar.from(configurations.aresAgent)
aresJvmArguments.aspectjRuntimeJar.from(configurations.aresAspectjRuntime)
`;

  test("the provider class and its jar wiring are not remnants", () => {
    expect(aresFreeBuildScript(ARES_BUILD + PROVIDER, [reserved]).ok).toBe(true);
  });

  test.each([
    ["a -javaagent argument", "test { jvmArgs '-javaagent:/x/agent.jar' }"],
    ["a JVM argument provider", "test { jvmArgumentProviders << aresJvmArguments }"],
    ["another use of aresJvmArguments", "def args = aresJvmArguments"],
    ["an AspectJ plugin", "apply plugin: 'io.freefair.aspectj.post-compile-weaving'"],
    ["an aspect or inpath dependency", "dependencies {\n  inpath 'x:y:1'\n}"],
    ["a script applied from a URL", "apply from: 'https://example.org/ares.gradle'"],
  ])("refuses %s in build.gradle", (name, line) => {
    const result = aresFreeBuildScript(`${ARES_BUILD}${PROVIDER}${line}\n`, []);
    expect(result).toEqual({
      ok: false,
      reason: `build.gradle still installs ${name} once the recognised Ares hooks are removed`,
    });
  });

  test("scans every Gradle script of the test repository, not only build.gradle", () => {
    const applied = file(
      "gradle/agent.gradle",
      "tasks.withType(Test) { jvmArgs '-javaagent:a.jar' }",
    );
    expect(
      aresFreeBuildScript(ARES_BUILD + "apply from: 'gradle/agent.gradle'\n", [applied]),
    ).toEqual({
      ok: false,
      reason:
        "gradle/agent.gradle still installs a -javaagent argument once the recognised Ares hooks are removed",
    });
  });
});

describe("the PIT init script", () => {
  test("names the tests explicitly and mutates each changed class with its nested classes", () => {
    const script = pitInitScript(["de.x.Stub"], ["de.x.StubTest"]);
    expect(script).toContain("targetClasses = ['de.x.Stub', 'de.x.Stub$*']");
    expect(script).toContain("targetTests = ['de.x.StubTest']");
    expect(script).toContain("outputFormats = ['XML']");
    expect(script).not.toContain("line.separator");
  });

  test("refuses anything that is not a class name", () => {
    expect(() => pitInitScript(["de.x.Stub']; evil('"], [])).toThrow("not a Java class name");
  });

  test("derives the test classes from the test sources", () => {
    expect(
      testClassNames([
        file("test/de/x/BTest.java", "package de.x;\nclass BTest {}"),
        file("test/de/x/ATest.java", "package de.x;\nclass ATest {}"),
        file("build.gradle", ""),
      ]),
    ).toEqual(["de.x.ATest", "de.x.BTest"]);
  });
});

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<mutations partial="true">
<mutation detected='true' status='KILLED' numberOfTestsRun='9'><sourceFile>Desk.java</sourceFile><mutatedClass>de.x.Desk</mutatedClass><mutatedMethod>status</mutatedMethod><methodDescription>()I</methodDescription><lineNumber>40</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.ConditionalsBoundaryMutator</mutator></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='3'><sourceFile>Desk.java</sourceFile><mutatedClass>de.x.Desk$1</mutatedClass><mutatedMethod>apply</mutatedMethod><methodDescription>()I</methodDescription><lineNumber>52</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator></mutation>
<mutation detected='false' status='NO_COVERAGE' numberOfTestsRun='0'><sourceFile>Client.java</sourceFile><mutatedClass>de.x.Client</mutatedClass><mutatedMethod>main</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>10</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.VoidMethodCallMutator</mutator></mutation>
<mutation detected='true' status='TIMED_OUT' numberOfTestsRun='1'><sourceFile>Desk.java</sourceFile><mutatedClass>de.x.Desk</mutatedClass><mutatedMethod>loop</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>60</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.IncrementsMutator</mutator></mutation>
<mutation detected='false' status='NON_VIABLE' numberOfTestsRun='0'><sourceFile>Desk.java</sourceFile><mutatedClass>de.x.Desk</mutatedClass><mutatedMethod>loop</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>61</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.NullReturnValsMutator</mutator></mutation>
<mutation detected='true' status='KILLED' numberOfTestsRun='1'><sourceFile>Given.java</sourceFile><mutatedClass>de.x.Given</mutatedClass><mutatedMethod>f</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>3</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.VoidMethodCallMutator</mutator></mutation>
</mutations>`;

describe("PIT reports", () => {
  test("parse into mutants with the mutator's simple name", () => {
    const mutants = parsePitReport(REPORT);
    expect(mutants).toHaveLength(6);
    expect(mutants?.[1]).toEqual({
      class: "de.x.Desk$1",
      method: "apply",
      line: 52,
      mutator: "MathMutator",
      status: "SURVIVED",
    });
  });

  test("refuse anything that is not a PIT report", () => {
    expect(parsePitReport("<report/>")).toBeNull();
    expect(parsePitReport('<!DOCTYPE x><mutations status="x"/>')).toBeNull();
  });

  test("score detected mutants of the changed classes, with uncovered mutants as survivors", () => {
    const summary = summariseMutants(parsePitReport(REPORT) as Mutant[], [
      "de.x.Desk",
      "de.x.Client",
    ]);
    // Given is not a changed class; NON_VIABLE leaves the denominator.
    expect(summary.killed).toBe(2);
    expect(summary.denominator).toBe(4);
    expect(summary.coveredSurvivors).toBe(1);
    expect(summary.survivors.map((mutant) => mutant.status)).toEqual(["SURVIVED", "NO_COVERAGE"]);
    expect(summary.counts).toEqual({
      KILLED: 1,
      SURVIVED: 1,
      NO_COVERAGE: 1,
      TIMED_OUT: 1,
      NON_VIABLE: 1,
    });
  });
});

const passing = {
  compiled: true,
  tests_executed: true,
  test_cases: [{ name: "a", passed: true }],
  coverage: null,
  diagnostics: [],
};

function outcome(mutation?: BuildOutcome["mutation"]): BuildOutcome {
  return {
    template: { ...passing, test_cases: [{ name: "a", passed: false }] },
    solution: passing,
    attestation: {
      backend_id: "gradle",
      artemis_revision: null,
      build_agent_image: null,
      build_script_revision: null,
      toolchain: null,
      build_phase_scripts: [],
      build_branch: null,
      unattested: [],
    },
    ...(mutation === undefined ? {} : { mutation }),
  };
}

describe("mutation scores", () => {
  test("carry the score as a fraction and the survivors as evidence", () => {
    const [mutation, covered] = mutationScores(
      outcome({
        status: "measured",
        tool: "pitest test",
        target_classes: ["de.x.Desk", "de.x.Client"],
        mutants: parsePitReport(REPORT) as Mutant[],
      }),
    );
    expect(mutation).toMatchObject({
      metric_id: "mutation.score",
      status: "ok",
      value: 0.5,
      numerator: 2,
      denominator: 4,
    });
    expect(mutation?.evidence).toContain("survivor:Desk$1.apply:52 MathMutator covered=yes");
    expect(mutation?.evidence).toContain(
      "survivor:Client.main:10 VoidMethodCallMutator covered=no",
    );
    expect(mutation?.evidence).toContain("status:NO_COVERAGE=1");
    expect(covered).toMatchObject({ metric_id: "mutation.covered_survivors", value: 1 });
  });

  test("a backend without mutation analysis says so instead of scoring", () => {
    const scores = mutationScores(outcome());
    expect(scores.map((entry) => entry.status)).toEqual(["not_applicable", "not_applicable"]);
    expect(scores[0]?.message).toContain("does not run mutation analysis");
  });

  test("a PIT run without a report is an infrastructure failure, never a zero", () => {
    const scores = mutationScores(
      outcome({
        status: "failed",
        reason: "PIT produced no report",
        tool: null,
        target_classes: [],
        mutants: [],
      }),
    );
    expect(scores.map((entry) => entry.status)).toEqual(["infra_failure", "infra_failure"]);
    expect(scores.every((entry) => entry.value === undefined)).toBe(true);
  });

  test("a case PIT does not apply to is not applicable, with the reason", () => {
    const scores = mutationScores(
      outcome({
        status: "not_applicable",
        reason: "the tests use Ares 1",
        tool: null,
        target_classes: [],
        mutants: [],
      }),
    );
    expect(scores[0]).toMatchObject({ status: "not_applicable", message: "the tests use Ares 1" });
  });

  test("unfinished mutants or no viable mutant never produce a score", () => {
    const unfinished = mutationScores(
      outcome({
        status: "measured",
        tool: null,
        target_classes: ["de.x.A"],
        mutants: [{ class: "de.x.A", method: "f", line: 1, mutator: "M", status: "NOT_STARTED" }],
      }),
    );
    expect(unfinished[0]?.status).toBe("infra_failure");
    const empty = mutationScores(
      outcome({ status: "measured", tool: null, target_classes: ["de.x.A"], mutants: [] }),
    );
    expect(empty[0]?.status).toBe("not_applicable");
  });
});
