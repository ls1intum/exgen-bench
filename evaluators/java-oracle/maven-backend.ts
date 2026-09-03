import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BundleFile } from "../shared/bundle.ts";
import type {
  BuildBackend,
  BuildJob,
  BuildOutcome,
  SubmissionBuild,
  TestCaseResult,
} from "./backend.ts";
import { type HostBuildRun, inspectHostTool, runHostBuild, writeBuildFiles } from "./host-build.ts";
import { readJUnitReports } from "./junit-report.ts";

const ASSIGNMENT_DIRECTORY = "assignment";

const SUREFIRE_REPORTS = join("target", "surefire-reports");

const JACOCO_REPORT = join("target", "site", "jacoco", "jacoco.xml");

/**
 * Pinned so a coverage figure is attributable to a known instrumenter. Invoked as a goal rather than
 * written into the candidate's `pom.xml`: the pom is the generated artifact under evaluation, and an
 * evaluator that edits what it measures cannot claim to have measured it.
 */
const JACOCO_GOAL_PREFIX = "org.jacoco:jacoco-maven-plugin:0.8.12";

const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;

/**
 * The Java release a bundle's POMs ask for, or null when they say nothing.
 *
 * `maven.compiler.release` first because it is the modern and the strictest spelling; the
 * source/target pair and `java.version` are the older ones still emitted by real templates. The
 * highest wins: a multi-module bundle compiles under the newest release any module requires.
 */
export function declaredJavaReleaseForTest(files: readonly BundleFile[]): number | null {
  return declaredJavaRelease(files);
}

function declaredJavaRelease(files: readonly BundleFile[]): number | null {
  const pattern =
    /<(?:maven\.compiler\.release|maven\.compiler\.target|release|target|java\.version)>\s*(\d+)\s*</g;
  let highest: number | null = null;
  for (const file of files) {
    if (!file.path.endsWith("pom.xml")) {
      continue;
    }
    for (const match of file.content.matchAll(pattern)) {
      const release = Number(match[1]);
      if (Number.isFinite(release) && (highest === null || release > highest)) {
        highest = release;
      }
    }
  }
  return highest;
}

const MAXIMUM_DIAGNOSTIC_LINES = 40;

export const mavenBackendConfigSchema = z
  .object({
    kind: z.literal("maven"),
    command: z.string().min(1).default("mvn"),
    arguments: z.array(z.string().min(1)).default(["--batch-mode", "test"]),
    /**
     * Whether to instrument the run with JaCoCo. On by default: coverage is cheap here because the
     * suite is already being executed, and a backend that silently reports no coverage is
     * indistinguishable from one whose tests covered nothing.
     */
    coverage: z.boolean().default(true),
    /**
     * JDK homes by the Java release they provide, e.g. `{"17": "/usr/lib/jvm/java-17-openjdk-amd64"}`.
     *
     * A corpus is not one Java version. These candidates declare release 17 and the golden
     * references declare 25, so a single ambient `JAVA_HOME` builds at least one of them under a
     * toolchain it never asked for - which is how a correct exercise was once recorded as failing.
     * Declared here rather than discovered from the host so the choice is part of the configuration
     * digest and a published figure is attributable to a named JDK.
     */
    java_homes: z.record(z.string().regex(/^\d+$/), z.string().min(1)).default({}),
    build_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(15 * 60_000),
    local_repository: z.string().min(1).optional(),
    offline: z.boolean().default(false),
    java_home: z.string().min(1).optional(),
    work_directory: z.string().min(1).optional(),
    keep_build_trees: z.boolean().default(false),
  })
  .strict();

export type MavenBackendConfig = z.infer<typeof mavenBackendConfigSchema>;

function diagnostics(run: HostBuildRun): string[] {
  const lines = run.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) =>
      /\[ERROR\]|BUILD FAILURE|COMPILATION ERROR|Cannot find symbol|error:/i.test(line),
    );
  const selected = lines.slice(-MAXIMUM_DIAGNOSTIC_LINES);
  if (run.timedOut) {
    selected.unshift(
      `the build exceeded its timeout after ${MAXIMUM_DIAGNOSTIC_LINES} reported lines`,
    );
  }
  return selected.map((line) => line.slice(0, 512));
}

export class MavenBuildBackend implements BuildBackend {
  readonly id = "maven";

  /** The JDK home each build actually used, so the reported toolchain is the one that ran. */
  private buildJavaHome: string | undefined;

  private readonly resolvedToolchain = new Map<string, string | null>();

  constructor(private readonly config: MavenBackendConfig) {}

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    const parent = this.config.work_directory ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "exgen-oracle-"));
    try {
      signal.throwIfAborted();
      const template = await this.buildSubmission(
        root,
        "template",
        job.bundle.tests,
        job.bundle.template,
        signal,
      );
      signal.throwIfAborted();
      const solution = await this.buildSubmission(
        root,
        "solution",
        job.bundle.tests,
        job.bundle.solution,
        signal,
      );
      return {
        template,
        solution,
        attestation: {
          backend_id: this.id,
          artemis_revision: null,
          build_agent_image: null,
          build_script_revision: null,
          toolchain: await this.toolchain(),
          build_phase_scripts: [],
          build_branch: null,
          // This backend runs the generated Maven project directly rather than through a deployment,
          // so nothing here is attested by Artemis. What ran is the recorded toolchain.
          unattested: [
            "artemis_revision",
            "build_agent_image",
            "build_script_revision",
            "build_phase_scripts",
            "build_branch",
          ],
        },
      };
    } finally {
      if (!this.config.keep_build_trees) {
        await rm(root, { recursive: true, force: true });
      }
    }
  }

  /**
   * The Maven and Java versions that ran this build.
   *
   * Keyed by JDK home rather than memoised once: with a JDK chosen per artifact, a single cached
   * string would attribute every candidate's numbers to whichever toolchain happened to build the
   * first one. Evidence that names the wrong JDK is worse than no evidence, because it invites the
   * conclusion that a build failure was the artifact's fault.
   */
  private async toolchain(): Promise<string | null> {
    const home = this.buildJavaHome ?? this.config.java_home ?? "";
    const cached = this.resolvedToolchain.get(home);
    if (cached !== undefined) {
      return cached;
    }
    const stdout = await inspectHostTool(
      [this.config.command, "--batch-mode", "--version"],
      this.environment(this.buildJavaHome).env,
    );
    const maven = stdout === null ? undefined : /Apache Maven \S+/.exec(stdout)?.[0];
    const runtime = stdout === null ? undefined : /Java version: \S+?(?=,|\s|$)/.exec(stdout)?.[0];
    const resolved = stdout === null ? null : [maven, runtime].filter(Boolean).join("; ") || null;
    this.resolvedToolchain.set(home, resolved);
    return resolved;
  }

  private environment(javaHome?: string): { env?: Record<string, string | undefined> } {
    const home = javaHome ?? this.config.java_home;
    if (home === undefined) {
      return {};
    }
    // PATH too, not only JAVA_HOME: Maven resolves `java` from PATH for forked test JVMs, so setting
    // JAVA_HOME alone compiles against one release and runs the tests on another.
    return {
      env: { ...process.env, JAVA_HOME: home, PATH: `${home}/bin:${process.env.PATH ?? ""}` },
    };
  }

  /**
   * The JDK to build this bundle with, chosen from what the bundle declares.
   *
   * Throws rather than falling back when a release is declared and no JDK is configured for it.
   * Silently building release 25 sources on a 17 toolchain fails in a way that reads as a defect in
   * the artifact, and building 17 sources on 25 can pass while measuring the wrong thing.
   */
  private resolveJavaHome(files: readonly BundleFile[]): {
    home: string | undefined;
    release: number | null;
  } {
    const release = declaredJavaRelease(files);
    if (release === null) {
      return { home: this.config.java_home, release };
    }
    const configured = this.config.java_homes[String(release)];
    if (configured !== undefined) {
      return { home: configured, release };
    }
    if (Object.keys(this.config.java_homes).length === 0) {
      return { home: this.config.java_home, release };
    }
    throw new Error(
      `no JDK configured for Java release ${release}; java_homes declares ` +
        `${Object.keys(this.config.java_homes).sort().join(", ")}`,
    );
  }

  private async buildSubmission(
    root: string,
    variant: "template" | "solution",
    tests: BundleFile[],
    submission: BundleFile[],
    signal: AbortSignal,
  ): Promise<SubmissionBuild> {
    const directory = join(root, variant);
    await mkdir(directory, { recursive: true });
    await writeBuildFiles(directory, tests);
    await writeBuildFiles(join(directory, ASSIGNMENT_DIRECTORY), submission);

    // The JDK follows the artifact, not the operator's shell.
    const { home: javaHome } = this.resolveJavaHome([...tests, ...submission]);
    const run = await this.runMaven(directory, signal, javaHome);
    this.buildJavaHome = javaHome;
    const cases = await this.readReports(directory);
    // Maven reports a non-zero exit for a failing test as well as for a failing compile, so the exit
    // code alone cannot separate them. Surefire wrote a report only if the sources compiled and the
    // suite started, which is the distinction the gate needs.
    const testsExecuted = cases !== null;
    const compiled = testsExecuted || run.exitCode === 0;
    return {
      compiled,
      tests_executed: testsExecuted,
      test_cases: cases ?? [],
      coverage: testsExecuted ? await this.readCoverage(directory) : null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  private runMaven(
    directory: string,
    signal: AbortSignal,
    javaHome?: string,
  ): Promise<HostBuildRun> {
    const argv = [this.config.command];
    if (this.config.coverage) {
      // prepare-agent before the lifecycle phase that runs the tests, report after it.
      argv.push(`${JACOCO_GOAL_PREFIX}:prepare-agent`);
    }
    argv.push(...this.config.arguments);
    if (this.config.coverage) {
      argv.push(`${JACOCO_GOAL_PREFIX}:report`);
    }
    if (this.config.offline) {
      argv.push("--offline");
    }
    if (this.config.local_repository !== undefined) {
      argv.push(`-Dmaven.repo.local=${this.config.local_repository}`);
    }
    const environment = this.environment(javaHome).env;
    return runHostBuild({
      argv,
      directory,
      ...(environment === undefined ? {} : { environment }),
      signal,
      timeoutMs: this.config.build_timeout_ms,
      maximumOutputBytes: MAXIMUM_DIAGNOSTIC_BYTES,
    });
  }

  private async readReports(directory: string): Promise<TestCaseResult[] | null> {
    return readJUnitReports(join(directory, SUREFIRE_REPORTS));
  }

  /**
   * Statement and branch coverage of the assignment sources, from JaCoCo's XML report.
   *
   * Null rather than zero whenever the report is absent or carries no counter of that kind: a suite
   * that never ran and a suite that covered nothing are different facts, and only the second is a
   * measurement. JaCoCo names statement coverage INSTRUCTION.
   */
  private async readCoverage(
    directory: string,
  ): Promise<{ statement: number | null; branch: number | null } | null> {
    let report: string;
    try {
      report = await readFile(join(directory, JACOCO_REPORT), "utf8");
    } catch {
      return null;
    }
    const ratio = (kind: string): number | null => {
      // The report-level counters are the last ones in the document; per-class counters precede them.
      const counters = [
        ...report.matchAll(
          new RegExp(`<counter type="${kind}" missed="(\\d+)" covered="(\\d+)"\\s*/>`, "g"),
        ),
      ];
      const last = counters.at(-1);
      if (last === undefined) {
        return null;
      }
      const missed = Number(last[1]);
      const covered = Number(last[2]);
      const total = missed + covered;
      return total === 0 ? null : covered / total;
    };
    const statement = ratio("INSTRUCTION");
    const branch = ratio("BRANCH");
    return statement === null && branch === null ? null : { statement, branch };
  }
}
