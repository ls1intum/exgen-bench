import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { readTextBounded } from "../../../src/core/files.ts";
import type { BundleFile } from "../../kit/bundle.ts";
import { changedClassNames } from "../../kit/changes.ts";
import {
  type BuildBackend,
  type BuildJob,
  type BuildOutcome,
  type MutationRun,
  passesEveryTest,
  type SubmissionBuild,
  type TestCaseResult,
} from "./backend.ts";
import { type HostBuildRun, inspectHostTool, runHostBuild, writeBuildFiles } from "./host-build.ts";
import { readJUnitReports } from "./junit-report.ts";
import {
  aresFreeBuildScript,
  parsePitReport,
  PIT_TOOL,
  pitInitScript,
  testClassNames,
} from "./mutation.ts";
import { auditCompiler, GRADLE_ANALYSIS_INIT, readSourceCoverage } from "./source-analysis.ts";

const ASSIGNMENT_DIRECTORY = "assignment";
const TEST_REPORTS = join("build", "test-results", "test");
const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;
const MAXIMUM_DIAGNOSTIC_LINES = 40;
const BUILD_SCRIPT = "build.gradle";
const PIT_REPORT = join("build", "reports", "pitest", "mutations.xml");
const MAXIMUM_PIT_REPORT_BYTES = 16 * 1024 * 1024;

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
    analysis: z.boolean().default(true),
    /**
     * Run PIT on an Ares-free copy of the solution build once both submissions built and the
     * solution passed every test. Builds that skip analysis skip it too.
     */
    mutation: z.boolean().default(true),
    java_home: z.string().min(1).optional(),
    work_directory: z.string().min(1).optional(),
    keep_build_trees: z.boolean().default(false),
  })
  .strict();

export type GradleBackendConfig = z.infer<typeof gradleBackendConfigSchema>;

function diagnostics(
  run: HostBuildRun,
  pattern = /FAILURE:|BUILD FAILED|Compilation failed|error:/i,
): string[] {
  const lines = run.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => pattern.test(line))
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
        false,
      );
      signal.throwIfAborted();
      const solution = await this.buildSubmission(
        root,
        "solution",
        job.bundle.tests,
        job.bundle.solution,
        signal,
        this.config.analysis && job.analysis !== false,
      );
      const extra =
        this.config.mutation &&
        job.analysis !== false &&
        template.compiled &&
        passesEveryTest(solution);
      const mutation = extra ? await this.mutationPass(root, job, signal) : undefined;
      return {
        template,
        solution,
        ...(mutation === undefined ? {} : { mutation }),
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
    analysis: boolean,
  ): Promise<SubmissionBuild> {
    const directory = join(root, variant);
    await mkdir(directory, { recursive: true });
    await writeBuildFiles(directory, tests);
    await writeBuildFiles(join(directory, ASSIGNMENT_DIRECTORY), submission);

    if (analysis)
      await writeFile(join(directory, "exgen-analysis.init.gradle"), GRADLE_ANALYSIS_INIT);
    const run = await this.runGradle(directory, signal, analysis);
    const cases = await this.readReports(directory);
    const testsExecuted = cases !== null;
    const lines =
      analysis && testsExecuted
        ? await readSourceCoverage(
            join(directory, "build/reports/jacoco/test/jacocoTestReport.xml"),
          )
        : null;
    const sourceAudit =
      analysis && testsExecuted && run.exitCode === 0
        ? await auditCompiler(directory, submission, this.config.java_home, signal)
        : { compiler: null, suppressions: 0 };
    const branchTotal = lines?.reduce((n, l) => n + l.branchesCovered + l.branchesMissed, 0) ?? 0;
    return {
      ...(analysis ? { analysis: { lines, ...sourceAudit } } : {}),
      compiled: testsExecuted || run.exitCode === 0,
      tests_executed: testsExecuted,
      test_cases: cases ?? [],
      coverage:
        lines && lines.length > 0
          ? {
              statement: lines.filter((l) => l.covered).length / lines.length,
              branch:
                branchTotal > 0
                  ? lines.reduce((n, l) => n + l.branchesCovered, 0) / branchTotal
                  : null,
            }
          : null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  /**
   * PIT on a copy of the solution build with the Ares hooks removed, mutating only the classes the
   * solution adds or changes. The graded builds above are untouched; this copy exists only so PIT's
   * minion can run, and its own test run must stay green or PIT refuses to mutate.
   */
  private async mutationPass(
    root: string,
    job: BuildJob,
    signal: AbortSignal,
  ): Promise<MutationRun> {
    const targets = changedClassNames(job.bundle.template, job.bundle.solution);
    const base = { tool: PIT_TOOL, target_classes: targets };
    if (targets.length === 0) {
      return {
        status: "not_applicable",
        reason: "the solution changes no Java class",
        ...base,
        mutants: [],
      };
    }
    const script = job.bundle.tests.find((file) => file.path === BUILD_SCRIPT);
    if (script === undefined) {
      return {
        status: "not_applicable",
        reason: `the test repository has no ${BUILD_SCRIPT} at its root`,
        ...base,
        mutants: [],
      };
    }
    const patched = aresFreeBuildScript(script.content, job.bundle.tests);
    if (!patched.ok)
      return { status: "not_applicable", reason: patched.reason, ...base, mutants: [] };
    const tests = testClassNames(job.bundle.tests);
    let init: string;
    try {
      init = pitInitScript(targets, tests);
    } catch (error) {
      return {
        status: "not_applicable",
        reason: error instanceof Error ? error.message : String(error),
        ...base,
        mutants: [],
      };
    }
    const directory = join(root, "mutation");
    await mkdir(directory, { recursive: true });
    await writeBuildFiles(directory, job.bundle.tests);
    await writeBuildFiles(join(directory, ASSIGNMENT_DIRECTORY), job.bundle.solution);
    await writeFile(join(directory, BUILD_SCRIPT), patched.script);
    await writeFile(join(directory, "exgen-mutation.init.gradle"), init);
    signal.throwIfAborted();
    const run = await this.runGradle(directory, signal, false, [
      "--init-script",
      join(directory, "exgen-mutation.init.gradle"),
      "pitest",
    ]);
    let xml: string | null = null;
    try {
      xml = await readTextBounded(join(directory, PIT_REPORT), MAXIMUM_PIT_REPORT_BYTES);
    } catch {
      xml = null;
    }
    const mutants = xml === null ? null : parsePitReport(xml);
    if (run.timedOut || run.exitCode !== 0 || mutants === null) {
      const detail = diagnostics(
        run,
        /PitHelpError|did not pass without mutation|What went wrong|FAILURE:|error:/i,
      )
        .slice(0, 6)
        .join(" | ");
      return {
        status: "failed",
        reason: `PIT produced no report${detail === "" ? "" : `: ${detail}`}`,
        ...base,
        mutants: [],
      };
    }
    return { status: "measured", ...base, mutants };
  }

  private runGradle(
    directory: string,
    signal: AbortSignal,
    analysis: boolean,
    extra: string[] = [],
  ): Promise<HostBuildRun> {
    const argv = [this.config.command, ...this.config.arguments, ...extra];
    if (analysis)
      argv.push(
        "--init-script",
        join(directory, "exgen-analysis.init.gradle"),
        "exgenAnalysisClasspath",
      );
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
