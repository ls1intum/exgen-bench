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
import { type HostBuildRun, inspectHostTool, runHostBuild, writeBuildFiles } from "./host-build.ts";
import { readJUnitReports } from "./junit-report.ts";

const ASSIGNMENT_DIRECTORY = "assignment";
const TEST_REPORTS = join("build", "test-results", "test");
const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;
const MAXIMUM_DIAGNOSTIC_LINES = 40;

export const gradleBackendConfigSchema = z
  .object({
    kind: z.literal("gradle"),
    command: z.string().min(1).default("gradle"),
    arguments: z.array(z.string().min(1)).default(["--no-daemon", "clean", "test"]),
    build_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(15 * 60_000),
    user_home: z.string().min(1).optional(),
    offline: z.boolean().default(false),
    java_home: z.string().min(1).optional(),
    work_directory: z.string().min(1).optional(),
    keep_build_trees: z.boolean().default(false),
  })
  .strict();

export type GradleBackendConfig = z.infer<typeof gradleBackendConfigSchema>;

function diagnostics(run: HostBuildRun): string[] {
  const lines = run.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /FAILURE:|BUILD FAILED|Compilation failed|error:/i.test(line))
    .slice(-MAXIMUM_DIAGNOSTIC_LINES)
    .map((line) => line.slice(0, 512));
  if (run.timedOut) lines.unshift("the Gradle build exceeded its configured timeout");
  return lines;
}

export class GradleBuildBackend implements BuildBackend {
  readonly id = "gradle";

  private resolvedToolchain: string | null | undefined;

  constructor(private readonly config: GradleBackendConfig) {}

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    const parent = this.config.work_directory ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "exgen-oracle-gradle-"));
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
          // This backend runs the generated Gradle project directly rather than through a deployment,
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

  private environment(): { env?: Record<string, string | undefined> } {
    const overrides: Record<string, string | undefined> = {};
    if (this.config.java_home !== undefined) overrides.JAVA_HOME = this.config.java_home;
    if (this.config.user_home !== undefined) overrides.GRADLE_USER_HOME = this.config.user_home;
    return Object.keys(overrides).length === 0 ? {} : { env: { ...process.env, ...overrides } };
  }

  private async toolchain(): Promise<string | null> {
    if (this.resolvedToolchain !== undefined) return this.resolvedToolchain;
    const stdout = await inspectHostTool(
      [this.config.command, "--version"],
      this.environment().env,
    );
    if (stdout !== null) {
      const gradle = /Gradle \S+/.exec(stdout)?.[0];
      const runtime = /JVM:\s+[^\n]+/.exec(stdout)?.[0];
      this.resolvedToolchain = [gradle, runtime].filter(Boolean).join("; ") || null;
    } else {
      this.resolvedToolchain = null;
    }
    return this.resolvedToolchain;
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

    const run = await this.runGradle(directory, signal);
    const cases = await this.readReports(directory);
    const testsExecuted = cases !== null;
    return {
      compiled: testsExecuted || run.exitCode === 0,
      tests_executed: testsExecuted,
      test_cases: cases ?? [],
      coverage: null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  private runGradle(directory: string, signal: AbortSignal): Promise<HostBuildRun> {
    const argv = [this.config.command, ...this.config.arguments];
    if (this.config.offline) argv.push("--offline");
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
    return readJUnitReports(join(directory, TEST_REPORTS));
  }
}
