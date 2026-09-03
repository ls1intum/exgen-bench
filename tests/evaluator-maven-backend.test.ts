import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
          // The stub is not Maven, so appending Maven goals to its argv would only change what
          // `sleep` is asked to sleep for. This test is about cancellation, not coverage.
          coverage: false,
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

  test("reads the report-level counters, not a single class's", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-coverage-"));
    temporaryDirectories.push(directory);
    const backend = new MavenBuildBackend(
      mavenBackendConfigSchema.parse({ kind: "maven", work_directory: directory }),
    );
    await mkdir(join(directory, "target", "site", "jacoco"), { recursive: true });
    // Class counters precede the report's own, and one of them is deliberately 1/1 so reading the
    // wrong element would score this a perfect 1.0.
    await writeFile(
      join(directory, "target", "site", "jacoco", "jacoco.xml"),
      `<report name="r"><package name="p"><class name="A">
         <counter type="LINE" missed="0" covered="1"/><counter type="BRANCH" missed="0" covered="1"/>
       </class></package>
       <counter type="INSTRUCTION" missed="90" covered="10"/>
       <counter type="LINE" missed="3" covered="1"/>
       <counter type="BRANCH" missed="1" covered="3"/></report>`,
    );

    const coverage = await (
      backend as unknown as {
        readCoverage: (
          d: string,
        ) => Promise<{ statement: number | null; branch: number | null } | null>;
      }
    ).readCoverage(directory);

    // LINE, not INSTRUCTION: the latter counts bytecode and would report 0.1 here.
    expect(coverage).toEqual({ statement: 0.25, branch: 0.75 });
  });

  test("reports no branch coverage rather than zero when the code has no branches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-coverage-"));
    temporaryDirectories.push(directory);
    const backend = new MavenBuildBackend(
      mavenBackendConfigSchema.parse({ kind: "maven", work_directory: directory }),
    );
    await mkdir(join(directory, "target", "site", "jacoco"), { recursive: true });
    await writeFile(
      join(directory, "target", "site", "jacoco", "jacoco.xml"),
      `<report name="r"><counter type="LINE" missed="0" covered="4"/></report>`,
    );

    const coverage = await (
      backend as unknown as {
        readCoverage: (
          d: string,
        ) => Promise<{ statement: number | null; branch: number | null } | null>;
      }
    ).readCoverage(directory);

    // A suite that covered no branches and code that has none are different facts.
    expect(coverage).toEqual({ statement: 1, branch: null });
  });

  test("selects the JDK the bundle declares and refuses a release it has none for", async () => {
    const backend = new MavenBuildBackend(
      mavenBackendConfigSchema.parse({
        kind: "maven",
        java_homes: { "17": "/jdk17", "25": "/jdk25" },
      }),
    );
    const resolve = (
      backend as unknown as { resolveJavaHome: (f: unknown[]) => string | undefined }
    ).resolveJavaHome.bind(backend);
    const pom = (release: string) => [
      {
        path: "pom.xml",
        content: `<project><properties><maven.compiler.release>${release}</maven.compiler.release></properties></project>`,
        bytes: 0,
      },
    ];

    expect(resolve(pom("17"))).toBe("/jdk17");
    expect(resolve(pom("25"))).toBe("/jdk25");
    // Building 21 sources on 17 fails as though the artifact were at fault, so this must not fall back.
    expect(() => resolve(pom("21"))).toThrow(/no JDK configured for Java release 21/);
  });

  test("leaves the environment alone when no JDK is configured", async () => {
    const backend = new MavenBuildBackend(mavenBackendConfigSchema.parse({ kind: "maven" }));
    const resolve = (
      backend as unknown as { resolveJavaHome: (f: unknown[]) => string | undefined }
    ).resolveJavaHome.bind(backend);
    const environment = (
      backend as unknown as { environment: (h?: string) => { env?: Record<string, string> } }
    ).environment.bind(backend);

    // An adopter of neither field must see exactly the previous behaviour: an inherited environment.
    expect(resolve([{ path: "pom.xml", content: "<project/>", bytes: 0 }])).toBeUndefined();
    expect(environment(undefined)).toEqual({});
  });

  test("puts the selected JDK on PATH as well as in JAVA_HOME", async () => {
    const backend = new MavenBuildBackend(mavenBackendConfigSchema.parse({ kind: "maven" }));
    const environment = (
      backend as unknown as { environment: (h?: string) => { env?: Record<string, string> } }
    ).environment.bind(backend);

    const env = environment("/jdk17").env;

    // Maven forks test JVMs off PATH, so JAVA_HOME alone compiles and runs on different releases.
    expect(env?.JAVA_HOME).toBe("/jdk17");
    expect(env?.PATH?.startsWith("/jdk17/bin:")).toBe(true);
    // A trailing empty PATH element is the current directory, which here is a tree of generated files.
    expect(env?.PATH?.endsWith(":")).toBe(false);
  });

  test("takes the declared Java release from where Maven takes it, and nowhere else", async () => {
    const { declaredJavaRelease } = await import("../evaluators/java-oracle/maven-backend.ts");
    const pom = (body: string) => [
      { path: "pom.xml", content: `<project>${body}</project>`, bytes: 0 },
    ];

    expect(
      declaredJavaRelease(
        pom("<properties><maven.compiler.release>25</maven.compiler.release></properties>"),
      ),
    ).toBe(25);
    // The spelling Artemis's own template emits, inside the compiler plugin rather than in properties.
    expect(
      declaredJavaRelease(
        pom(
          `<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId>
             <configuration><source>17</source><target>17</target></configuration>
           </plugin></plugins></build>`,
        ),
      ),
    ).toBe(17);
    // 1.8 is the historical spelling of 8.
    expect(
      declaredJavaRelease(
        pom("<properties><maven.compiler.target>1.8</maven.compiler.target></properties>"),
      ),
    ).toBe(8);
    // A bundle compiles under the newest release any of its modules requires.
    expect(
      declaredJavaRelease([
        {
          path: "pom.xml",
          content: "<project><properties><java.version>17</java.version></properties></project>",
          bytes: 0,
        },
        {
          path: "a/pom.xml",
          content: "<project><properties><java.version>25</java.version></properties></project>",
          bytes: 0,
        },
      ]),
    ).toBe(25);

    // Everything below is a number that is not a Java release. Reading any of them either selects a
    // JDK the sources were not written for, or fails the candidate for a toolchain nobody asked for.
    expect(
      declaredJavaRelease(
        pom(
          `<build><plugins><plugin><artifactId>maven-antrun-plugin</artifactId>
             <configuration><target>1</target></configuration></plugin></plugins></build>`,
        ),
      ),
    ).toBeNull();
    expect(
      declaredJavaRelease(
        pom(
          `<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId>
             <configuration><systemPropertyVariables><target>42</target></systemPropertyVariables>
           </configuration></plugin></plugins></build>`,
        ),
      ),
    ).toBeNull();
    expect(
      declaredJavaRelease(pom("<!-- <maven.compiler.release>99</maven.compiler.release> -->")),
    ).toBeNull();
    // Whether a profile is active is decided at build time, so a release declared there is not one
    // this can resolve by reading the file.
    expect(
      declaredJavaRelease(
        pom(
          `<profiles><profile><properties>
             <maven.compiler.release>25</maven.compiler.release>
           </properties></profile></profiles>`,
        ),
      ),
    ).toBeNull();
    // A property reference resolves only during a build; guessing at it would be worse than declining.
    expect(
      declaredJavaRelease(
        pom(
          "<properties><maven.compiler.release>${java.version}</maven.compiler.release></properties>",
        ),
      ),
    ).toBeNull();
    expect(declaredJavaRelease(pom("<artifactId>x</artifactId>"))).toBeNull();
    // Only POMs are consulted; a release-shaped number in source is not a toolchain request.
    expect(
      declaredJavaRelease([
        {
          path: "src/A.java",
          content: "<project><properties><java.version>25</java.version></properties></project>",
          bytes: 0,
        },
      ]),
    ).toBeNull();
  });

  test("gives up on a build that outlives its timeout and says so", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-maven-timeout-"));
    try {
      const backend = new MavenBuildBackend(
        mavenBackendConfigSchema.parse({
          kind: "maven",
          command: "sleep",
          arguments: ["600"],
          // The stub is not Maven, so appending Maven goals to its argv would only change what
          // `sleep` is asked to sleep for. This test is about cancellation, not coverage.
          coverage: false,
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
          build_phase_scripts: [],
          build_branch: null,
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
