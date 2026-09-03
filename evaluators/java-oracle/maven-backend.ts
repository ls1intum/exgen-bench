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

  private resolvedToolchain: string | null | undefined;

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

  private async toolchain(): Promise<string | null> {
    if (this.resolvedToolchain !== undefined) {
      return this.resolvedToolchain;
    }
    const stdout = await inspectHostTool(
      [this.config.command, "--batch-mode", "--version"],
      this.environment().env,
    );
    if (stdout !== null) {
      const maven = /Apache Maven \S+/.exec(stdout)?.[0];
      const runtime = /Java version: \S+?(?=,|\s|$)/.exec(stdout)?.[0];
      this.resolvedToolchain = [maven, runtime].filter(Boolean).join("; ") || null;
    } else {
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
      coverage: testsExecuted ? await this.readCoverage(directory) : null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  private runMaven(directory: string, signal: AbortSignal): Promise<HostBuildRun> {
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
