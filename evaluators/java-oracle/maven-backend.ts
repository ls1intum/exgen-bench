import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { type HostBuildRun, runHostBuild, writeBuildFiles } from "./host-build.ts";
import { readJUnitReports } from "./junit-report.ts";

/**
 * Builds the candidate the way the target platform does: the tests repository is the Maven project,
 * and the submission under test is checked out into `assignment/`, which is what the generated
 * `pom.xml` names as its source directory.
 */
const ASSIGNMENT_DIRECTORY = "assignment";

const SUREFIRE_REPORTS = join("target", "surefire-reports");

/** Enough of the build log to explain a failure, bounded so a runaway build cannot fill the journal. */
const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;

const MAXIMUM_DIAGNOSTIC_LINES = 40;

export const mavenBackendConfigSchema = z
  .object({
    kind: z.literal("maven"),
    /** Resolved through PATH unless it is a path. */
    command: z.string().min(1).default("mvn"),
    /**
     * `test` alone: the acceptance gate is decided by compilation and the test results, so a build
     * that packages or installs would only add failure modes the gate does not read.
     */
    arguments: z.array(z.string().min(1)).default(["--batch-mode", "test"]),
    build_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(15 * 60_000),
    /**
     * A per-backend Maven repository keeps a benchmark run from depending on whatever the host
     * happens to have cached, at the cost of one cold resolve. Omitted means the host default.
     */
    local_repository: z.string().min(1).optional(),
    /** Fails the resolve instead of reaching the network. Requires a warm `local_repository`. */
    offline: z.boolean().default(false),
    /**
     * The JDK the build runs on. Omitted means whatever the host resolves, which is a fidelity risk:
     * the generated `pom.xml` targets a specific release and the test harness installs a security
     * manager, so a host JDK far from the target platform's can fail a candidate for reasons that
     * have nothing to do with it. Pin it to the JDK the target platform builds with.
     */
    java_home: z.string().min(1).optional(),
    /** Where build trees are created. Omitted means the system temporary directory. */
    work_directory: z.string().min(1).optional(),
    /** Keeps build trees after the run so a surprising verdict can be reproduced by hand. */
    keep_build_trees: z.boolean().default(false),
  })
  .strict();

export type MavenBackendConfig = z.infer<typeof mavenBackendConfigSchema>;

/** The tail of the build log, which is where Maven reports what stopped it. */
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

/**
 * Builds and runs a generated exercise with Maven, which is what the target platform's build agent
 * does. The two submissions are built in separate trees from the same tests, so neither can observe
 * the other's `target/`.
 */
export class MavenBuildBackend implements BuildBackend {
  readonly id = "maven";

  private resolvedToolchain: string | null | undefined;

  constructor(private readonly config: MavenBackendConfig) {}

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    const parent = this.config.work_directory ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "exgen-oracle-"));
    try {
      // Two builds, so cancellation has to be checked between them: killing the first child and then
      // starting the second would make a cancelled evaluation cost twice the build it was stopping.
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
          // This backend runs the generated Maven project directly rather than through a deployment,
          // so nothing here is attested by Artemis. What ran is the recorded toolchain.
          unattested: ["artemis_revision", "build_agent_image", "build_script_revision"],
        },
      };
    } finally {
      if (!this.config.keep_build_trees) {
        await rm(root, { recursive: true, force: true });
      }
    }
  }

  /**
   * `mvn --version` reports the Maven and the JDK in one line each, and the JDK is the one that
   * decides whether a candidate's verdict is portable. Resolved once and cached: it is the same for
   * every candidate this backend builds, and it must never be the reason a build fails.
   */
  private async toolchain(): Promise<string | null> {
    if (this.resolvedToolchain !== undefined) {
      return this.resolvedToolchain;
    }
    try {
      // `--batch-mode` because Maven colours its banner, and an escape sequence at the start of a
      // line defeats an anchored match.
      const child = Bun.spawn([this.config.command, "--batch-mode", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        ...this.environment(),
      });
      const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      // Unanchored: Maven colours its banner, and the escape sequence sits between the line start
      // and the name. Each phrase occurs once in the version output.
      const maven = /Apache Maven \S+/.exec(stdout)?.[0];
      const runtime = /Java version: \S+?(?=,|\s|$)/.exec(stdout)?.[0];
      this.resolvedToolchain = [maven, runtime].filter(Boolean).join("; ") || null;
    } catch {
      this.resolvedToolchain = null;
    }
    return this.resolvedToolchain;
  }

  private environment(): { env?: Record<string, string | undefined> } {
    return this.config.java_home === undefined
      ? {}
      : { env: { ...process.env, JAVA_HOME: this.config.java_home } };
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

    const run = await this.runMaven(directory, signal);
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
      coverage: null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  private runMaven(directory: string, signal: AbortSignal): Promise<HostBuildRun> {
    const argv = [this.config.command, ...this.config.arguments];
    if (this.config.offline) {
      argv.push("--offline");
    }
    if (this.config.local_repository !== undefined) {
      argv.push(`-Dmaven.repo.local=${this.config.local_repository}`);
    }
    const environment = this.environment().env;
    return runHostBuild({
      argv,
      directory,
      ...(environment === undefined ? {} : { environment }),
      signal,
      timeoutMs: this.config.build_timeout_ms,
      maximumOutputBytes: MAXIMUM_DIAGNOSTIC_BYTES,
    });
  }

  /** Null when the suite never started, which is not the same as a suite that ran and reported nothing. */
  private async readReports(directory: string): Promise<TestCaseResult[] | null> {
    return readJUnitReports(join(directory, SUREFIRE_REPORTS));
  }
}
