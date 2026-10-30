import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";

import { sha256 } from "../src/core/canonical.ts";
import { templateDiff } from "../tools/tier3-expert-rating/builder/diff.ts";
import { refreshFindings } from "../tools/tier3-expert-rating/builder/refresh.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "exgen-refresh-")),
    study = join(root, "study"),
    archive = join(root, "archive");
  await mkdir(join(study, "exercises"), { recursive: true });
  await mkdir(join(root, "jdk/bin"), { recursive: true });
  await mkdir(join(archive, "case"), { recursive: true });
  const script = join(root, "gradle");
  await writeFile(
    script,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'Gradle test\\nJVM: test\\n'; exit 0; fi
mkdir -p build/test-results/test build/reports/jacoco/test
printf '' > build/exgen-classpath.txt
printf '<report><package name=""><sourcefile name="A.java"><line nr="1" mi="0" ci="1" mb="0" cb="0"/></sourcefile></package></report>' > build/reports/jacoco/test/jacocoTestReport.xml
case "$PWD" in
 */template) printf '<testsuite name="A" tests="1" failures="1"><testcase name="checks"><failure message="secretGen Not implemented"/></testcase></testsuite>' > build/test-results/test/TEST.xml;;
 *) printf '<testsuite name="A" tests="1" failures="0"><testcase name="checks"/></testsuite>' > build/test-results/test/TEST.xml;;
esac
`,
  );
  await chmod(script, 0o755);
  await writeFile(join(root, "jdk/bin/javac"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "jdk/bin/javac"), 0o755);
  await writeFile(
    join(root, "oracle.yaml"),
    stringify({
      schema_version: "1",
      backend: { kind: "gradle", command: script, arguments: [], java_home: join(root, "jdk") },
    }),
  );
  const template = [
      {
        path: "src/A.java",
        content: "class A { int f(){throw new UnsupportedOperationException();} }",
      },
    ],
    solution = [{ path: "src/A.java", content: "class A { int f(){return 1;} }" }];
  const files = {
    "problem-statement.md": "Implement f.",
    "template/src/A.java": template[0]!.content,
    "solution/src/A.java": solution[0]!.content,
    "tests/build.gradle": "plugins { id 'java' }",
  };
  for (const [path, text] of Object.entries(files)) {
    const full = join(archive, "case", path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  }
  await writeFile(
    join(archive, "MANIFEST.json"),
    JSON.stringify({
      run_id: "run",
      published: [
        {
          case_id: "case",
          attempt_id: "attempt",
          files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, sha256(t)])),
        },
      ],
    }),
  );
  await writeFile(
    join(study, "study.yaml"),
    stringify({
      schema_version: "1",
      id: "round-two",
      title: "Study",
      instrument_version: "4",
      contact: { name: "Team", email: "team@example.org" },
      deadlines: {},
      consent: {
        summary: "Study",
        details: "Study",
        statements: [{ id: "participate", text: "I agree" }],
      },
      ratings_per_exercise: 1,
      exercises: [{ code: "E1", phase: "early", source: { run: "run", case: "case" } }],
      raters: [{ id: "P1", role: "pilot", exercises: ["E1"] }],
      build: { oracle: "../oracle.yaml", blinding: ["secretGen"] },
    }),
  );
  const exercise = {
    schema_version: "1",
    id: "ABCD",
    phase: "early",
    brief: "Implement f.",
    statement: "Implement f.",
    facts: { tests: 1, tasks: 0, methods: 1, types: 0, lines: 1 },
    template,
    diff: templateDiff(template, solution),
    tests: [{ task: null, tests: [{ name: "checks", message: "stale", generic: false }] }],
    findings: { items: [], metrics: [{ label: "stale", value: "stale" }] },
  };
  const text = JSON.stringify(exercise, null, 2) + "\n";
  await writeFile(join(study, "exercises/ABCD.json"), text);
  await writeFile(
    join(study, "exercises/manifest.json"),
    JSON.stringify({
      schema_version: "1",
      study_id: "round-one",
      exercises: [
        {
          code: "E1",
          id: "ABCD",
          phase: "early",
          sha256: sha256(text),
          source: {
            run_id: "run",
            attempt_id: "attempt",
            case_id: "case",
            system_id: "generator",
            artifact_digest: "a".repeat(64),
          },
          blinding_replacements: 0,
        },
      ],
    }),
  );
  return { root, study, archive };
}

test("refreshes a frozen copy from verified original sources, regenerates test messages and preserves source material", async () => {
  const f = await fixture();
  try {
    await refreshFindings(f.study, f.archive, {
      rebuild: true,
      report: join(f.root, "report.json"),
    });
    const text = await readFile(join(f.study, "exercises/ABCD.json"), "utf8"),
      exercise = JSON.parse(text),
      manifest = JSON.parse(await readFile(join(f.study, "exercises/manifest.json"), "utf8"));
    expect(manifest.study_id).toBe("round-two");
    expect(manifest.exercises[0].sha256).toBe(sha256(text));
    expect(exercise.statement).toBe("Implement f.");
    expect(exercise.tests[0].tests[0].message).not.toBe("stale");
    expect(text).not.toContain("secretGen");
    expect(
      exercise.findings.metrics.some(
        (m: { label: string }) => m.label === "Learner-written lines exercised",
      ),
    ).toBe(true);
    const report = JSON.parse(await readFile(join(f.root, "report.json"), "utf8"));
    expect(report.implementationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.results[0].sourceFilesVerified).toBe(4);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);

test("rejects an unconfirmed rebuild, in-study reports and changed archive bytes before writing frozen files", async () => {
  const f = await fixture();
  try {
    const file = join(f.study, "exercises/ABCD.json"),
      before = await readFile(file, "utf8");
    await expect(
      refreshFindings(f.study, f.archive, { rebuild: false, report: join(f.root, "report.json") }),
    ).rejects.toThrow("--rebuild");
    await expect(
      refreshFindings(f.study, f.archive, { rebuild: true, report: join(f.study, "report.json") }),
    ).rejects.toThrow("outside the study");
    await writeFile(join(f.archive, "case/solution/src/A.java"), "changed");
    await expect(
      refreshFindings(f.study, f.archive, { rebuild: true, report: join(f.root, "report.json") }),
    ).rejects.toThrow("Archive digest mismatch");
    expect(await readFile(file, "utf8")).toBe(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);
