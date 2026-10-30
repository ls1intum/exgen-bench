import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BuildBackend,
  SubmissionBuild,
} from "../tools/tier1-deterministic/java-oracle/backend.ts";
import {
  auditCompiler,
  readSourceCoverage,
  withoutWarningSuppressions,
} from "../tools/tier1-deterministic/java-oracle/source-analysis.ts";
import {
  classifyProbe,
  constraintProbes,
  runConstraintProbes,
} from "../tools/tier3-expert-rating/builder/constraints.ts";
import { automaticFindings } from "../tools/tier3-expert-rating/builder/findings.ts";

const build: SubmissionBuild = {
  compiled: true,
  tests_executed: true,
  test_cases: [{ name: "first", passed: true }],
  coverage: null,
  diagnostics: [],
};

describe("source evidence for the rater", () => {
  test("does not display a model or reference score even if its metric ID matches a deterministic one", () => {
    for (const id of ["llm-judge", "promise-traceability-model", "java-reference"]) {
      const findings = automaticFindings(
        [
          {
            evaluator: { id },
            scores: [
              {
                metric_id: "concept.required_constructs_present",
                metric_version: "1",
                status: "ok",
                value: false,
                evidence: ["model opinion"],
              },
            ],
          },
        ],
        [],
      );
      expect(findings.items).toEqual([]);
    }
  });
  test("suppression audit preserves strings, comments, qualified annotations and line numbers", () => {
    const original =
      '// @SuppressWarnings("unchecked")\nclass A { String s = "@SuppressWarnings(\\"unchecked\\")";\n @java.lang.SuppressWarnings({"unchecked", "rawtypes"}) void f() {} }';
    const result = withoutWarningSuppressions(original);
    expect(result.count).toBe(1);
    expect(result.source.length).toBe(original.length);
    expect(result.source.split("\n").length).toBe(3);
    expect(result.source).toContain("// @SuppressWarnings");
    expect(result.source).toContain('String s = "@SuppressWarnings');
    expect(result.source).not.toContain("@java.lang.SuppressWarnings");
  });
  test("does not disable a candidate-defined annotation", () => {
    const source = "@interface SuppressWarnings {} @SuppressWarnings class A {}";
    expect(withoutWarningSuppressions(source)).toEqual({ source, count: 0 });
  });
  test("reads actual coverage counters, keeping uncovered lines and missing reports distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "exgen-coverage-"));
    try {
      const file = join(root, "jacoco.xml");
      expect(await readSourceCoverage(file)).toBeNull();
      await writeFile(
        file,
        '<report><package name="example"><sourcefile name="A.java"><line nr="5" mi="2" ci="0" mb="1" cb="1"/><line nr="6" mi="0" ci="3" mb="0" cb="0"/></sourcefile></package></report>',
      );
      expect(await readSourceCoverage(file)).toEqual([
        { path: "example/A.java", line: 5, covered: false, branchesCovered: 1, branchesMissed: 1 },
        { path: "example/A.java", line: 6, covered: true, branchesCovered: 0, branchesMissed: 0 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("only constructs probes for requested, supported constraints", () => {
    const files = [
      {
        path: "src/A.java",
        content:
          "class A { long count(java.util.List<String> values) { return values.stream().filter(value -> value.length() > 1).count(); } int sum(int n) { int total=0; while(n>0){total+=n;n--;}return total; } }",
      },
    ];
    expect(constraintProbes(files, [])).toEqual([]);
    const probes = constraintProbes(files, ["stream_api", "while_loop"]);
    expect(probes).toHaveLength(2);
    expect(probes[0]?.replacement).toContain("for (var value : values)");
    expect(probes[1]?.replacement).toContain("for (;n>0;)");
    expect(
      constraintProbes(
        [
          {
            path: "A.java",
            content: "class A { long f() { return data.parallelStream().count(); } }",
          },
        ],
        ["stream_api"],
      ),
    ).toEqual([]);
  });
  test("a passing partial test report is not an accepted constraint probe", () => {
    expect(classifyProbe(build, ["first", "second"])).toBe("incomplete");
    expect(classifyProbe(build, ["first"])).toBe("accepted");
    expect(
      classifyProbe({ ...build, test_cases: [{ name: "first", passed: false }] }, ["first"]),
    ).toBe("rejected");
  });
  test("compile-only audit preserves original sources and reports compiler locations without trusting suppressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "exgen-compiler-test-"));
    try {
      await mkdir(join(root, "build"));
      await mkdir(join(root, "jdk/bin"), { recursive: true });
      await writeFile(join(root, "build/exgen-classpath.txt"), "");
      const javac = join(root, "jdk/bin/javac");
      await writeFile(
        javac,
        '#!/bin/sh\nprintf "%s\\n" "A.java:2:4: compiler.warn.raw.class.use: List" "A.java:3:4: compiler.warn.prob.found.req: (compiler.misc.unchecked.cast.to.type: Object, List<String>)"\n',
      );
      await chmod(javac, 0o755);
      const original = '@SuppressWarnings("unchecked")\nclass A { java.util.List raw; }';
      const files = [{ path: "src/A.java", content: original, bytes: original.length }];
      const result = await auditCompiler(
        root,
        files,
        join(root, "jdk"),
        new AbortController().signal,
      );
      expect(result).toEqual({
        compiler: [
          { path: "src/A.java", line: 2, kind: "raw_type" },
          { path: "src/A.java", line: 3, kind: "unchecked" },
        ],
        suppressions: 1,
      });
      expect(await readFile(join(root, "exgen-compiler-audit/src/A.java"), "utf8")).not.toContain(
        "@SuppressWarnings",
      );
      expect(files[0]?.content).toBe(original);
      await writeFile(javac, "#!/bin/sh\nexit 1\n");
      expect(
        (await auditCompiler(root, files, join(root, "jdk"), new AbortController().signal))
          .compiler,
      ).toBeNull();
      expect(
        (await auditCompiler(join(root, "missing"), files, undefined, new AbortController().signal))
          .compiler,
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("list pipeline and unsupported shapes have explicit, bounded probe behaviour", async () => {
    const files = [
      {
        path: "src/A.java",
        content:
          "class A {\n java.util.List<String> values(java.util.List<String> input) {\n return input.stream().filter(x -> x.length()>1).map(x -> x.trim()).toList();\n }\n}",
      },
    ];
    const probes = constraintProbes(files, ["stream_api"]);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.replacement).toContain("java.util.List<String> __exgenValues");
    expect(
      constraintProbes(
        [
          {
            path: "src/A.java",
            content: files[0]!.content.replace("map(x -> x.trim())", "map(y -> y.trim())"),
          },
        ],
        ["stream_api"],
      ),
    ).toEqual([]);
    const calls: Array<unknown> = [];
    const backend = {
      id: "test",
      build: async (job) => {
        calls.push(job);
        return {
          template: build,
          solution: build,
          attestation: {
            backend_id: "test",
            artemis_revision: null,
            build_agent_image: null,
            build_script_revision: null,
            toolchain: null,
            build_phase_scripts: [],
            build_branch: null,
            unattested: [],
          },
        };
      },
    } satisfies BuildBackend;
    const results = await runConstraintProbes(
      backend,
      {
        request: {} as never,
        bundle: {
          root: "/tmp",
          statement: "",
          statementPath: "statement.md",
          template: [],
          tests: [],
          solution: files.map((f) => ({
            ...f,
            bytes: f.content.length,
            rawContent: new Uint8Array([1]),
          })),
        },
      },
      probes,
      ["first"],
      new AbortController().signal,
    );
    expect(results[0]?.outcome).toBe("accepted");
    expect(calls[0]).toMatchObject({ analysis: false });
    expect(classifyProbe({ ...build, compiled: false }, ["first"])).toBe("not_compiled");
    expect(classifyProbe({ ...build, tests_executed: false }, ["first"])).toBe("incomplete");
  });
  test("findings distinguish accepted constraints, unavailable audits, and incomplete code-change probes", () => {
    const probe = {
      path: "src/A.java",
      line: 2,
      method: "A.f",
      constraint: "stream_api" as const,
      start: 0,
      end: 1,
      replacement: "replacement",
    };
    const measurements = {
      build,
      solution: [],
      diff: [],
      constraints: [
        { probe, outcome: "accepted" as const, tests: 12 },
        { probe: { ...probe, method: "A.g" }, outcome: "accepted" as const, tests: 12 },
        { probe, outcome: "incomplete" as const, tests: 0 },
      ],
      unsupportedConstraints: ["while_loop"],
    };
    const findings = automaticFindings(
      [],
      [],
      { ran: 1, caught: 1, survivors: [], discarded: 2, unresolved: 1 },
      measurements,
    );
    expect(findings.items).toHaveLength(1);
    expect(findings.items[0]?.details).toHaveLength(2);
    expect(findings.items[0]?.title).toBe("Tests pass without the required stream pipeline");
    expect(
      findings.metrics.find((m) => m.label === "Coding-constraint changes rejected")?.value,
    ).toBe("0 of 2");
    expect(
      findings.metrics.find((m) => m.label === "Code changes that did not compile")?.value,
    ).toBe("2");
    expect(
      findings.metrics.find((m) => m.label === "Code changes without a completed result")?.value,
    ).toBe("1");
    expect(findings.metrics.find((m) => m.label === "Type-safety audit")?.value).toContain(
      "Not available",
    );
  });
  test("scope coverage and compiler warnings to changed source lines", () => {
    const findings = automaticFindings(
      [],
      [],
      { ran: 2, caught: 1, survivors: [] },
      {
        build: {
          ...build,
          analysis: {
            lines: [
              { path: "A.java", line: 1, covered: false, branchesCovered: 0, branchesMissed: 2 },
              { path: "A.java", line: 2, covered: true, branchesCovered: 1, branchesMissed: 1 },
            ],
            compiler: [{ path: "src/A.java", line: 2, kind: "unchecked" }],
            suppressions: 1,
          },
        },
        solution: [
          { path: "src/A.java", content: "supplied\nreturn (List<String>) raw;", bytes: 0 },
        ],
        diff: [
          {
            path: "src/A.java",
            change: "modified",
            hunks: [
              {
                header: "@@",
                lines: [
                  { kind: "context", text: "supplied", old: 1, new: 1 },
                  { kind: "added", text: "return (List<String>) raw;", new: 2 },
                ],
              },
            ],
          },
        ],
        constraints: [],
      },
    );
    expect(findings.metrics).toEqual([
      { label: "Learner-written lines exercised", value: "1 of 1" },
      { label: "Branch outcomes exercised", value: "1 of 2" },
      { label: "Small code changes rejected", value: "1 of 2" },
    ]);
    expect(findings.items.map((f) => f.category)).toEqual(["Test coverage", "Type safety"]);
    expect(findings.items[1]?.details.join(" ")).toContain("suppressions disabled");
  });
});
