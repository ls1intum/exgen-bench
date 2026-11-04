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
  type BypassRun,
  type MutationRun,
  passesEveryTest,
  type SubmissionBuild,
  type TestCaseResult,
} from "./backend.ts";
import {
  findMainProbe,
  hardCodedMain,
  type MainProbe,
  MAXIMUM_TRANSCRIPT_CHARACTERS,
  runMainInitScript,
} from "./bypass.ts";
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
const MAIN_OUTPUT = join("build", "exgen-main");
const MAIN_TIMEOUT_SECONDS = 20;
const NO_BUDGET = "too little of the evaluation's time budget remained for this extra pass";

/**
 * The solution's `main` output, or why there is none: `failed` when the build broke before `main`
 * could run, which is never a property of the candidate.
 */
type Transcript = { probe: MainProbe; stdout: string } | { unavailable: string; failed?: true };

async function readOptional(path: string, maximumBytes: number): Promise<string | null> {
  try {
    return await readTextBounded(path, maximumBytes);
  } catch {
    return null;
  }
}

/**
 * What the solution's `main` printed. `exgenRunMain` creates `stdout.txt` before `main` starts and
 * writes `exit.txt` after it ends, so a missing `exit.txt` with a `stdout.txt` is a `main` that ran
 * out of time, while no `stdout.txt` at all is a build that never reached it.
 */
async function readTranscript(
  directory: string,
  probe: MainProbe,
  run: HostBuildRun,
): Promise<Transcript> {
  if (run.timedOut) {
    return {
      unavailable: "the Ares-free build exceeded its time limit before main's output was recorded",
      failed: true,
    };
  }
  const stdout = await readOptional(
    join(directory, MAIN_OUTPUT, "stdout.txt"),
    4 * MAXIMUM_TRANSCRIPT_CHARACTERS,
  );
  if (stdout === null) {
    const detail = diagnostics(run).slice(0, 4).join(" | ");
    return {
      unavailable: `the Ares-free build never ran the solution's main${detail === "" ? "" : `: ${detail}`}`,
      failed: true,
    };
  }
  const exit = (await readOptional(join(directory, MAIN_OUTPUT, "exit.txt"), 64))?.trim();
  if (exit === undefined) {
    return { unavailable: `the solution's main did not finish within ${MAIN_TIMEOUT_SECONDS} s` };
  }
  if (exit !== "0") return { unavailable: `the solution's main exited with status ${exit}` };
  if (stdout.length > MAXIMUM_TRANSCRIPT_CHARACTERS) {
    return {
      unavailable: `the solution's main printed more than ${MAXIMUM_TRANSCRIPT_CHARACTERS} characters`,
    };
  }
  return { probe, stdout };
}

/** Time kept back for the evaluator itself once the extra passes end. */
const BUDGET_RESERVE_MS = 60_000;
/** An extra pass with less of the evaluation's time left than this is not started. */
const MINIMUM_EXTRA_PASS_MS = 60_000;

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
    /**
     * The time limit of each extra pass (PIT with main capture, then the bypass build). Each pass
     * also stops short of the evaluation's own timeout, so a slow extra pass never costs the oracle
     * verdict; a pass without enough time left is reported as an infrastructure failure.
     */
    extra_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(10 * 60_000),
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
    const started = Date.now();
    const budget = job.request.timeout_ms;
    const extraTimeout = (): number | null => {
      if (budget === undefined) return this.config.extra_timeout_ms;
      const remaining = budget - (Date.now() - started) - BUDGET_RESERVE_MS;
      return remaining < MINIMUM_EXTRA_PASS_MS
        ? null
        : Math.min(this.config.extra_timeout_ms, remaining);
    };
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
      const aresFree = extra
        ? await this.aresFreePass(root, job, signal, extraTimeout())
        : undefined;
      const bypass =
        aresFree === undefined
          ? undefined
          : await this.bypassPass(root, job, aresFree.transcript, signal, extraTimeout());
      return {
        template,
        solution,
        ...(aresFree === undefined ? {} : { mutation: aresFree.mutation }),
        ...(bypass === undefined ? {} : { bypass }),
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
   * solution adds or changes, and in the same Gradle run the solution's `main` when the bypass probe
   * applies. The graded builds are untouched; this copy exists only so PIT's minion can run and
   * `main` can run without the woven Ares aspects, and its own tests must stay green or PIT refuses
   * to mutate.
   */
  private async aresFreePass(
    root: string,
    job: BuildJob,
    signal: AbortSignal,
    timeoutMs: number | null,
  ): Promise<{ mutation: MutationRun; transcript: Transcript }> {
    const targets = changedClassNames(job.bundle.template, job.bundle.solution);
    const base = { tool: PIT_TOOL, target_classes: targets, mutants: [] };
    const skip = (reason: string) => ({
      mutation: { status: "not_applicable" as const, reason, ...base },
      transcript: { unavailable: reason },
    });
    if (targets.length === 0)
      return skip("the solution changes no Java class outside test classes");
    const script = job.bundle.tests.find((file) => file.path === BUILD_SCRIPT);
    if (script === undefined) return skip(`the test repository has no ${BUILD_SCRIPT} at its root`);
    const patched = aresFreeBuildScript(script.content, job.bundle.tests);
    if (!patched.ok) return skip(patched.reason);
    const probe = findMainProbe(job.bundle.template, job.bundle.solution, job.bundle.tests);
    const scripts: string[] = [];
    try {
      scripts.push(pitInitScript(targets, testClassNames(job.bundle.tests)));
      if ("className" in probe)
        scripts.push(runMainInitScript(probe.className, MAIN_TIMEOUT_SECONDS));
    } catch (error) {
      return skip(error instanceof Error ? error.message : String(error));
    }
    if (timeoutMs === null) {
      return {
        mutation: { status: "failed", reason: NO_BUDGET, ...base },
        transcript: { unavailable: NO_BUDGET, failed: true },
      };
    }
    const directory = join(root, "mutation");
    await mkdir(directory, { recursive: true });
    await writeBuildFiles(directory, job.bundle.tests);
    await writeBuildFiles(join(directory, ASSIGNMENT_DIRECTORY), job.bundle.solution);
    await writeFile(join(directory, BUILD_SCRIPT), patched.script);
    const extra: string[] = ["--continue"];
    for (const [index, content] of scripts.entries()) {
      const name = `exgen-extra-${index}.init.gradle`;
      await writeFile(join(directory, name), content);
      extra.push("--init-script", name);
    }
    extra.push("pitest", ...("className" in probe ? ["exgenRunMain"] : []));
    signal.throwIfAborted();
    const run = await this.runGradle(directory, signal, false, extra, timeoutMs);
    return {
      mutation: await this.readMutation(directory, run, base),
      transcript: "className" in probe ? await readTranscript(directory, probe, run) : probe,
    };
  }

  private async readMutation(
    directory: string,
    run: HostBuildRun,
    base: Omit<MutationRun, "status">,
  ): Promise<MutationRun> {
    let xml: string | null = null;
    try {
      xml = await readTextBounded(join(directory, PIT_REPORT), MAXIMUM_PIT_REPORT_BYTES);
    } catch {
      xml = null;
    }
    const mutants = xml === null || run.timedOut ? null : parsePitReport(xml);
    if (mutants === null) {
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
      };
    }
    return { status: "measured", ...base, mutants };
  }

  /**
   * The graded build of the solution with the probed `main` printing its own transcript instead of
   * computing it. Only the tests' verdicts are kept.
   */
  private async bypassPass(
    root: string,
    job: BuildJob,
    transcript: Transcript,
    signal: AbortSignal,
    timeoutMs: number | null,
  ): Promise<BypassRun> {
    const none = { main_class: null, transcript_characters: 0, test_cases: [] };
    if ("unavailable" in transcript) {
      return {
        status: transcript.failed === true ? "failed" : "not_applicable",
        reason: transcript.unavailable,
        ...none,
      };
    }
    const base = {
      main_class: transcript.probe.className,
      transcript_characters: transcript.stdout.length,
    };
    const original = job.bundle.solution.find((file) => file.path === transcript.probe.path);
    const replaced =
      original === undefined
        ? null
        : hardCodedMain(original.path, original.content, transcript.stdout);
    if (replaced === null) {
      return {
        status: "not_applicable",
        reason: "the main method body could not be located",
        ...base,
        test_cases: [],
      };
    }
    if (timeoutMs === null) return { status: "failed", reason: NO_BUDGET, ...base, test_cases: [] };
    const solution: BundleFile[] = job.bundle.solution.map((file) =>
      file.path === transcript.probe.path
        ? { path: file.path, content: replaced, bytes: Buffer.byteLength(replaced) }
        : file,
    );
    const directory = join(root, "bypass");
    await mkdir(directory, { recursive: true });
    await writeBuildFiles(directory, job.bundle.tests);
    await writeBuildFiles(join(directory, ASSIGNMENT_DIRECTORY), solution);
    signal.throwIfAborted();
    const run = await this.runGradle(directory, signal, false, [], timeoutMs);
    const cases = await this.readReports(directory);
    // Replacing a body that returns nothing with a print always compiles, so a build that ran no
    // test, or ran out of time, failed for a reason outside the candidate.
    if (run.timedOut || cases === null) {
      const detail = diagnostics(run).slice(0, 4).join(" | ");
      return {
        status: "failed",
        reason: `the build with a hard-coded main ${run.timedOut ? "exceeded its time limit" : "ran no tests"}${detail === "" ? "" : `: ${detail}`}`,
        ...base,
        test_cases: [],
      };
    }
    return { status: "measured", ...base, test_cases: cases };
  }

  /**
   * Gradle runs in the build tree, and init scripts are named relative to it, so the command line
   * stays valid when a wrapper runs the same tree elsewhere, such as under `/workspace` in a container.
   */
  private runGradle(
    directory: string,
    signal: AbortSignal,
    analysis: boolean,
    extra: string[] = [],
    timeoutMs = this.config.build_timeout_ms,
  ): Promise<HostBuildRun> {
    const argv = [this.config.command, ...this.config.arguments, ...extra];
    if (analysis)
      argv.push("--init-script", "exgen-analysis.init.gradle", "exgenAnalysisClasspath");
    if (this.config.offline) argv.push("--offline");
    const environment = this.environment().env;
    return runHostBuild({
      argv,
      directory,
      ...(environment === undefined ? {} : { environment }),
      signal,
      timeoutMs,
      maximumOutputBytes: MAXIMUM_DIAGNOSTIC_BYTES,
    });
  }

  private async readReports(directory: string): Promise<TestCaseResult[] | null> {
    return readJUnitReports(join(directory, TEST_REPORTS));
  }
}
